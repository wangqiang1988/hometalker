#!/usr/bin/env node
/**
 * 端到端自测脚本：验证 WebSocket 协议、鉴权、麦权状态机和音频转发。
 *
 * 用法：
 *   # 终端 1：启动服务
 *   FAMILY_CODE=test1234 node server/dist/index.js
 *   # 终端 2：跑测试
 *   node scripts/smoke.mjs
 *
 * 可用环境变量：
 *   SMOKE_URL      默认 ws://127.0.0.1:8443/ws
 *   FAMILY_CODE    默认 test1234
 *   SMOKE_INSECURE 设为 1 时跳过 TLS 证书校验（测 wss:// 自签证书时用）
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.resolve(__dirname, '..', 'server', 'package.json'))
const WebSocket = require('ws')

const URL = process.env.SMOKE_URL || 'ws://127.0.0.1:8443/ws'
const CODE = process.env.FAMILY_CODE || 'test1234'
const INSECURE = process.env.SMOKE_INSECURE === '1'

let passed = 0
let failed = 0

function ok(name, cond, extra = '') {
	if (cond) {
		passed++
		console.log(`  \x1b[32m✓\x1b[0m ${name}`)
	} else {
		failed++
		console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ' — ' + extra : ''}`)
	}
}

function section(title) {
	console.log(`\n\x1b[1m${title}\x1b[0m`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function connect(name, code = CODE) {
	const ws = new WebSocket(URL, { rejectUnauthorized: !INSECURE })
	const c = {
		ws,
		name,
		events: [],
		binaries: [],
		speaker: undefined,
		members: [],
		welcome: null,
		closeInfo: null,
	}
	c.send = (ev) => ws.send(JSON.stringify(ev))
	c.sendBinary = (buf) => ws.send(buf, { binary: true })
	c.clearBinaries = () => {
		c.binaries.length = 0
	}
	c.waitFor = async (pred, timeout = 4000) => {
		const t0 = Date.now()
		for (;;) {
			const hit = c.events.find(pred)
			if (hit) return hit
			if (Date.now() - t0 > timeout) throw new Error(`等待超时: ${name}`)
			await sleep(20)
		}
	}
	c.waitClose = async (timeout = 4000) => {
		const t0 = Date.now()
		while (!c.closeInfo) {
			if (Date.now() - t0 > timeout) throw new Error(`等待关闭超时: ${name}`)
			await sleep(20)
		}
		return c.closeInfo
	}

	ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, code })))
	ws.on('message', (data, isBinary) => {
		if (isBinary) {
			c.binaries.push(Buffer.from(data))
			return
		}
		let ev
		try {
			ev = JSON.parse(data.toString())
		} catch {
			return
		}
		c.events.push(ev)
		if (ev.t === 'welcome') c.welcome = ev
		if (ev.t === 'members') c.members = ev.members
		if (ev.t === 'speaker') c.speaker = ev.id
	})
	ws.on('close', (code, reason) => {
		c.closeInfo = { code, reason: reason?.toString() ?? '' }
	})
	ws.on('error', () => {})

	return c
}

async function main() {
	console.log(`目标: ${URL}`)

	// ---------- 鉴权 ----------
	section('鉴权')
	const bad = connect('入侵者', 'wrong-code')
	const badErr = await bad.waitFor((e) => e.t === 'error')
	ok('错误口令被拒绝', badErr.code === 'BAD_CODE', `实际 code=${badErr.code}`)
	const badClose = await bad.waitClose()
	ok('错误口令后连接被关闭(4401)', badClose.code === 4401, `实际 code=${badClose.code}`)

	const a = connect('妈妈')
	await a.waitFor((e) => e.t === 'welcome')
	ok('正确口令可以进入房间', !!a.welcome)
	ok('welcome 带有房间名', a.welcome?.room?.name === 'home', a.welcome?.room?.name)
	ok('welcome 带有音频配置', a.welcome?.cfg?.sampleRate === 16000)
	ok('welcome 带有成员列表', Array.isArray(a.welcome?.members))

	// ---------- 在线状态 ----------
	section('在线状态')
	const b = connect('爸爸')
	await b.waitFor((e) => e.t === 'welcome')
	await sleep(150)
	ok('A 能看到 B 在线', a.members.some((m) => m.name === '爸爸'), JSON.stringify(a.members))
	ok('B 能看到 A 在线', b.members.some((m) => m.name === '妈妈'))

	const c = connect('小明')
	await c.waitFor((e) => e.t === 'welcome')
	await sleep(150)
	ok('成员列表包含 3 人', a.members.length === 3, `实际 ${a.members.length}`)

	// ---------- 音频转发 ----------
	section('音频转发')
	const frame = Buffer.alloc(640)
	for (let i = 0; i < 640; i++) frame[i] = (i * 37) & 0xff

	a.clearBinaries()
	b.clearBinaries()
	a.send({ t: 'speak', on: true })
	await a.waitFor((e) => e.t === 'speaker' && e.id === a.welcome.you.id)
	await sleep(100)

	a.sendBinary(frame)
	await sleep(250)
	ok('说话人的音频被转发给 B', b.binaries.length >= 1, `B 收到 ${b.binaries.length} 帧`)
	ok('转发的音频字节完全一致', b.binaries.length >= 1 && b.binaries[0].equals(frame))
	ok('说话人自己不会收到自己的音频', a.binaries.length === 0, `A 收到 ${a.binaries.length} 帧`)

	// ---------- 非说话人的帧被丢弃 ----------
	section('麦权约束')
	b.clearBinaries()
	c.clearBinaries()
	c.sendBinary(Buffer.alloc(640, 7))
	await sleep(250)
	ok('非说话人发送的音频被丢弃', b.binaries.length === 0, `B 收到 ${b.binaries.length} 帧`)

	// ---------- 抢占 ----------
	section('抢麦')
	c.send({ t: 'speak', on: true })
	await sleep(250)
	ok('C 抢占后成为说话人', c.speaker === c.welcome.you.id, `speaker=${c.speaker}`)
	ok('A 收到说话人变更通知', a.speaker === c.welcome.you.id)

	// A 之前的帧不再被转发
	b.clearBinaries()
	a.sendBinary(Buffer.alloc(640, 9))
	await sleep(250)
	ok('失去麦权后 A 的音频不再转发', b.binaries.length === 0, `B 收到 ${b.binaries.length} 帧`)

	// ---------- 释放 ----------
	section('放麦')
	c.send({ t: 'speak', on: false })
	await sleep(250)
	ok('释放后麦权清空', c.speaker === null && a.speaker === null, `A=${a.speaker} C=${c.speaker}`)

	// ---------- 断线清理 ----------
	section('断线清理')
	c.ws.close()
	await sleep(300)
	ok('成员离开后从列表消失', !a.members.some((m) => m.name === '小明'), JSON.stringify(a.members))
	ok('剩余成员仍在线', a.members.length === 2, `实际 ${a.members.length}`)

	// ---------- 收尾 ----------
	a.ws.close()
	b.ws.close()
	await sleep(200)

	console.log(`\n\x1b[1m结果: ${passed} 通过, ${failed} 失败\x1b[0m`)
	process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
	console.error('\n自测异常终止:', err)
	process.exit(1)
})
