import type { ClientEvent, ConnStatus, Creds, ServerEvent } from '../types'

const BACKOFF_MIN = 1000
const BACKOFF_MAX = 10_000

/**
 * 房间 WebSocket 连接。
 * - 控制消息走 JSON 文本帧，音频走二进制帧（同一条连接，浏览器原生区分）
 * - 断线自动重连，指数退避；页面回到前台立即重连
 */
export class RoomConnection {
	private ws: WebSocket | null = null
	private creds: Creds | null = null
	private backoff = BACKOFF_MIN
	private timer: ReturnType<typeof setTimeout> | null = null
	private manualClose = false
	private welcomed = false

	onEvent: (e: ServerEvent) => void = () => {}
	onStatus: (s: ConnStatus) => void = () => {}
	onBinary: (data: ArrayBuffer) => void = () => {}
	onClose: (code: number, reason: string) => void = () => {}

	get connected(): boolean {
		return this.ws !== null && this.ws.readyState === WebSocket.OPEN
	}

	connect(creds: Creds): void {
		this.creds = creds
		this.manualClose = false
		this.backoff = BACKOFF_MIN
		this.open()
	}

	disconnect(): void {
		this.manualClose = true
		this.clearTimer()
		if (this.ws) {
			this.ws.onclose = null
			this.ws.close(1000, 'leave')
			this.ws = null
		}
		this.onStatus('closed')
	}

	send(ev: ClientEvent): void {
		if (!this.connected) return
		this.ws!.send(JSON.stringify(ev))
	}

	sendBinary(data: ArrayBuffer): void {
		if (!this.connected) return
		this.ws!.send(data)
	}

	/** 立刻重连（页面回到前台时调用，跳过退避等待） */
	reconnectNow(): void {
		if (this.manualClose) return
		if (this.connected) return
		this.clearTimer()
		this.backoff = BACKOFF_MIN
		this.open()
	}

	private open(): void {
		if (this.manualClose) return
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
		const url = `${proto}//${location.host}/ws`

		this.onStatus(this.welcomed ? 'reconnecting' : 'connecting')
		const ws = new WebSocket(url)
		ws.binaryType = 'arraybuffer'
		this.ws = ws

		ws.onopen = () => {
			this.onStatus(this.welcomed ? 'reconnecting' : 'connecting')
			if (this.creds) {
				ws.send(JSON.stringify({ t: 'join', name: this.creds.name, code: this.creds.code }))
			}
		}

		ws.onmessage = (e) => {
			if (typeof e.data === 'string') {
				let msg: ServerEvent
				try {
					msg = JSON.parse(e.data) as ServerEvent
				} catch {
					return
				}
				if (msg.t === 'welcome') {
					this.welcomed = true
					this.backoff = BACKOFF_MIN
					this.onStatus('online')
				}
				this.onEvent(msg)
			} else if (e.data instanceof ArrayBuffer) {
				this.onBinary(e.data)
			}
		}

		ws.onerror = () => {
			// onclose 一定会随后触发，重连逻辑统一在那里处理
		}

		ws.onclose = (e) => {
			this.ws = null
			this.onClose(e.code, e.reason || '')
			if (this.manualClose) {
				this.onStatus('closed')
				return
			}
			this.onStatus('reconnecting')
			this.scheduleReconnect()
		}
	}

	private scheduleReconnect(): void {
		this.clearTimer()
		const wait = this.backoff
		this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX)
		this.timer = setTimeout(() => {
			this.timer = null
			this.open()
		}, wait)
	}

	private clearTimer(): void {
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = null
		}
	}
}
