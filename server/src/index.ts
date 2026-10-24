import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import { loadConfig, type Config } from './config.js'
import { createLogger } from './log.js'
import { Room, RoomError, type ServerEvent } from './room.js'
import { StaticFiles } from './static.js'

const log = createLogger('server')

/** 口令错误次数限制：10 次失败锁 60 秒 */
const MAX_CODE_FAILURES = 10
const LOCKOUT_MS = 60_000
const JOIN_TIMEOUT_MS = 5_000
const HEARTBEAT_MS = 30_000

type Client = {
	ws: WebSocket
	ip: string
	memberId: string | null
	joined: boolean
}

function safeEqual(a: string, b: string): boolean {
	const ba = Buffer.from(a, 'utf8')
	const bb = Buffer.from(b, 'utf8')
	if (ba.length !== bb.length) {
		// 长度不同也要走一次比较，避免通过响应时间区分"长度不对"和"内容不对"
		timingSafeEqual(ba, ba)
		return false
	}
	return timingSafeEqual(ba, bb)
}

function clientIp(req: http.IncomingMessage): string {
	const xff = req.headers['x-forwarded-for']
	if (typeof xff === 'string' && xff.length > 0) {
		const first = xff.split(',')[0]
		if (first) return first.trim()
	}
	return req.socket.remoteAddress ?? 'unknown'
}

function main(): void {
	let cfg: Config
	try {
		cfg = loadConfig()
	} catch (err) {
		console.error('\n[启动失败]\n' + (err instanceof Error ? err.message : String(err)) + '\n')
		process.exit(1)
	}

	const room = new Room(cfg)
	const statics = new StaticFiles(cfg.publicDir)
	const failures = new Map<string, { count: number; until: number }>()

	const isLocked = (ip: string): boolean => {
		const rec = failures.get(ip)
		if (!rec) return false
		if (rec.until > Date.now()) return true
		failures.delete(ip)
		return false
	}
	const recordFailure = (ip: string): void => {
		const rec = failures.get(ip) ?? { count: 0, until: 0 }
		rec.count += 1
		if (rec.count >= MAX_CODE_FAILURES) {
			rec.until = Date.now() + LOCKOUT_MS
			log.warn(`IP ${ip} 口令连续错误 ${rec.count} 次，锁定 ${LOCKOUT_MS / 1000}s`)
		}
		failures.set(ip, rec)
	}
	const clearFailures = (ip: string): void => {
		failures.delete(ip)
	}

	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost')

		if (url.pathname === '/api/health') {
			res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
			res.end(
				JSON.stringify({
					ok: true,
					room: room.name,
					online: room.size,
					uptime: Math.round(process.uptime()),
				}),
			)
			return
		}

		if (url.pathname.startsWith('/api/')) {
			res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
			res.end(JSON.stringify({ ok: false, error: 'NOT_FOUND' }))
			return
		}

		if (!statics.serve(req, res)) {
			res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
			res.end('404 Not Found')
		}
	})

	const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })

	server.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url ?? '/', 'http://localhost')
		if (url.pathname !== '/ws') {
			socket.destroy()
			return
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			wss.emit('connection', ws, req)
		})
	})

	wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
		const client: Client = { ws, ip: clientIp(req), memberId: null, joined: false }
		const send = (ev: ServerEvent): void => {
			if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev))
		}

		// 心跳探活标记
		const alive = ws as WebSocket & { isAlive?: boolean }
		alive.isAlive = true
		ws.on('pong', () => {
			alive.isAlive = true
		})

		ws.on('error', (err) => log.warn(`连接错误 (${client.ip}): ${err.message}`))

		const joinTimer = setTimeout(() => {
			if (!client.joined) {
				send({ t: 'error', code: 'JOIN_TIMEOUT', message: '未在 5 秒内完成加入' })
				ws.close(4400, 'join timeout')
			}
		}, JOIN_TIMEOUT_MS)
		joinTimer.unref?.()

		ws.on('message', (data, isBinary) => {
			if (isBinary) {
				if (!client.joined || !client.memberId) return
				const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)
				room.broadcastAudio(client.memberId, buf)
				return
			}

			let msg: Record<string, unknown>
			try {
				msg = JSON.parse(data.toString())
			} catch {
				return
			}
			const t = typeof msg.t === 'string' ? msg.t : ''

			if (!client.joined) {
				if (t !== 'join') {
					send({ t: 'error', code: 'JOIN_REQUIRED', message: '第一条消息必须是 join' })
					ws.close(4400, 'join required')
					return
				}
				handleJoin(client, msg, send)
				return
			}

			switch (t) {
				case 'speak': {
					if (!client.memberId) return
					const on = msg.on === true
					const res = room.handleSpeak(client.memberId, on)
					if (!res.ok) {
						send({ t: 'error', code: res.code ?? 'SPEAK_FAILED', message: res.message ?? '无法取得麦权' })
					}
					break
				}
				case 'mute': {
					if (!client.memberId) return
					room.setMuted(client.memberId, msg.on === true)
					break
				}
				case 'ping': {
					send({ t: 'error', code: 'PONG', message: '' })
					break
				}
			}
		})

		ws.on('close', () => {
			clearTimeout(joinTimer)
			if (client.memberId) room.remove(client.memberId)
		})
	})

	function handleJoin(client: Client, msg: Record<string, unknown>, send: (ev: ServerEvent) => void): void {
		if (isLocked(client.ip)) {
			send({ t: 'error', code: 'LOCKED', message: '口令错误次数过多，请稍后再试' })
			client.ws.close(4429, 'locked')
			return
		}

		const name = typeof msg.name === 'string' ? msg.name.trim().slice(0, 20) : ''
		if (!name) {
			send({ t: 'error', code: 'NAME_REQUIRED', message: '请填写昵称' })
			client.ws.close(4400, 'name required')
			return
		}

		const code = typeof msg.code === 'string' ? msg.code : ''
		if (!safeEqual(code, cfg.familyCode)) {
			recordFailure(client.ip)
			log.warn(`IP ${client.ip} 口令错误`)
			send({ t: 'error', code: 'BAD_CODE', message: '家庭口令不正确' })
			client.ws.close(4401, 'bad code')
			return
		}
		clearFailures(client.ip)

		let member
		try {
			member = room.add(client.ws, name)
		} catch (err) {
			const code2 = err instanceof RoomError ? err.code : 'ROOM_FULL'
			const message = err instanceof Error ? err.message : '无法进入房间'
			send({ t: 'error', code: code2, message })
			client.ws.close(4403, code2)
			return
		}

		client.memberId = member.id
		client.joined = true
		send(room.welcomeFor(member))
		room.broadcastMembers()
	}

	// 心跳：探测死连接，及时回收（避免僵尸麦和成员列表残留）
	const heartbeat = setInterval(() => {
		for (const ws of wss.clients) {
			const anyWs = ws as WebSocket & { isAlive?: boolean }
			if (anyWs.isAlive === false) {
				ws.terminate()
				continue
			}
			anyWs.isAlive = false
			ws.ping()
		}
	}, HEARTBEAT_MS)
	heartbeat.unref?.()

	server.listen(cfg.port, () => {
		log.info(`房间 "${room.name}" 已启动，监听 :${cfg.port}`)
		log.info(`静态目录: ${cfg.publicDir}`)
		log.info(`上限 ${cfg.maxMembers} 人 | 发言超时 ${cfg.maxSpeakMs}ms | 抢麦模式 ${cfg.speakMode}`)
	})

	const shutdown = (sig: string): void => {
		log.info(`收到 ${sig}，正在关闭...`)
		clearInterval(heartbeat)
		for (const ws of wss.clients) ws.close(1001, 'server shutdown')
		room.dispose()
		server.close(() => process.exit(0))
		setTimeout(() => process.exit(0), 3000).unref()
	}
	process.on('SIGINT', () => shutdown('SIGINT'))
	process.on('SIGTERM', () => shutdown('SIGTERM'))

	// 家庭服务器要尽量"不因单次异常而整挂"
	process.on('uncaughtException', (err) => log.error('未捕获异常（进程继续运行）', err))
	process.on('unhandledRejection', (err) => log.error('未处理的 Promise 拒绝', err))
}

main()
