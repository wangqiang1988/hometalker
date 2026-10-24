import { randomUUID } from 'node:crypto'
import type { WebSocket } from 'ws'
import type { Config } from './config.js'
import { createLogger } from './log.js'

const log = createLogger('room')

export type MemberView = {
	id: string
	name: string
	muted: boolean
	speaking: boolean
}

type Member = MemberView & { ws: WebSocket }

export type RoomConfigView = {
	sampleRate: number
	frameMs: number
	maxSpeakMs: number
	halfDuplex: boolean
	speakMode: 'preempt' | 'exclusive'
}

export type ServerEvent =
	| {
			t: 'welcome'
			you: { id: string; name: string }
			room: { name: string }
			members: MemberView[]
			speaker: { id: string; name: string } | null
			cfg: RoomConfigView
	  }
	| { t: 'members'; members: MemberView[] }
	| { t: 'speaker'; id: string | null; name: string | null }
	| { t: 'error'; code: string; message: string }

export class RoomError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message)
		this.name = 'RoomError'
	}
}

/**
 * 家庭版只有一个固定房间。核心状态只有两个：
 *   - members：谁在线
 *   - speakerId：当前谁持有麦权（全局唯一）
 *
 * 关键不变量：**服务端只转发当前 speakerId 的音频帧**。
 * 这样"抢占"和"半双工"都是自然结果，不需要额外的停止指令或竞态处理。
 */
export class Room {
	readonly name: string
	private readonly cfg: Config
	private readonly members = new Map<string, Member>()
	private speakerId: string | null = null
	private speakTimer: NodeJS.Timeout | null = null

	constructor(cfg: Config) {
		this.cfg = cfg
		this.name = cfg.roomName
	}

	get size(): number {
		return this.members.size
	}

	get full(): boolean {
		return this.members.size >= this.cfg.maxMembers
	}

	memberViews(): MemberView[] {
		return [...this.members.values()].map((m) => ({
			id: m.id,
			name: m.name,
			muted: m.muted,
			speaking: m.speaking,
		}))
	}

	speakerView(): { id: string; name: string } | null {
		if (!this.speakerId) return null
		const m = this.members.get(this.speakerId)
		if (!m) return null
		return { id: m.id, name: m.name }
	}

	add(ws: WebSocket, name: string): Member {
		if (this.full) {
			throw new RoomError('ROOM_FULL', `房间已满（上限 ${this.cfg.maxMembers} 人）`)
		}
		const member: Member = {
			id: randomUUID(),
			name,
			muted: false,
			speaking: false,
			ws,
		}
		this.members.set(member.id, member)
		log.info(`${name} 进入房间，当前 ${this.members.size} 人`)
		return member
	}

	remove(memberId: string): void {
		const m = this.members.get(memberId)
		if (!m) return
		this.members.delete(memberId)
		log.info(`${m.name} 离开房间，当前 ${this.members.size} 人`)
		if (this.speakerId === memberId) {
			this.setSpeaker(null, 'holder-left')
		}
		this.broadcastMembers()
	}

	/**
	 * 申请/释放麦权。
	 * 返回 ok=false 时附带 code，供客户端提示。
	 */
	handleSpeak(memberId: string, on: boolean): { ok: boolean; code?: string; message?: string } {
		const member = this.members.get(memberId)
		if (!member) return { ok: false, code: 'NOT_IN_ROOM', message: '你已不在房间中' }

		if (!on) {
			if (this.speakerId === memberId) this.setSpeaker(null, 'released')
			return { ok: true }
		}

		if (this.speakerId === memberId) return { ok: true }

		if (this.speakerId) {
			if (this.cfg.speakMode === 'exclusive') {
				const holder = this.members.get(this.speakerId)
				return {
					ok: false,
					code: 'FLOOR_BUSY',
					message: `${holder?.name ?? '有人'} 正在说话`,
				}
			}
			// preempt：直接接管。旧说话人会收到 speaker 事件，从而自动停止发送。
			log.info(`${member.name} 抢占 ${this.members.get(this.speakerId)?.name ?? '?'} 的麦权`)
		}

		this.setSpeaker(memberId, 'acquired')
		return { ok: true }
	}

	setMuted(memberId: string, muted: boolean): void {
		const m = this.members.get(memberId)
		if (!m) return
		m.muted = muted
		this.broadcastMembers()
	}

	/** 麦权的唯一入口。所有状态变化都从这里走，保证不会出现两处状态不一致。 */
	private setSpeaker(memberId: string | null, reason: string): void {
		if (this.speakerId === memberId) return

		const prev = this.speakerId
		this.speakerId = memberId

		if (this.speakTimer) {
			clearTimeout(this.speakTimer)
			this.speakTimer = null
		}

		if (prev) {
			const old = this.members.get(prev)
			if (old) old.speaking = false
		}
		if (memberId) {
			const cur = this.members.get(memberId)
			if (cur) cur.speaking = true
		}

		if (memberId) {
			this.speakTimer = setTimeout(() => {
				log.info(`${this.members.get(memberId)?.name ?? '?'} 发言超时，自动放麦`)
				this.setSpeaker(null, 'timeout')
				const holder = this.members.get(memberId)
				if (holder) {
					this.sendTo(memberId, {
						t: 'error',
						code: 'SPEAK_TIMEOUT',
						message: `发言超过 ${Math.round(this.cfg.maxSpeakMs / 1000)} 秒，已自动放麦`,
					})
				}
			}, this.cfg.maxSpeakMs)
			this.speakTimer.unref?.()
		}

		log.info(`麦权变更: ${prev ?? '无'} -> ${memberId ?? '无'} (${reason})`)
		this.broadcast({ t: 'speaker', id: memberId, name: this.speakerView()?.name ?? null })
		this.broadcastMembers()
	}

	/** 只有当前说话人的音频才会被转发。其它人的帧直接丢弃。 */
	broadcastAudio(fromId: string, data: Buffer): void {
		if (this.speakerId !== fromId) return
		for (const m of this.members.values()) {
			if (m.id === fromId) continue
			if (m.ws.readyState !== m.ws.OPEN) continue
			m.ws.send(data, { binary: true })
		}
	}

	broadcast(ev: ServerEvent): void {
		const payload = JSON.stringify(ev)
		for (const m of this.members.values()) {
			if (m.ws.readyState !== m.ws.OPEN) continue
			m.ws.send(payload)
		}
	}

	sendTo(memberId: string, ev: ServerEvent): void {
		const m = this.members.get(memberId)
		if (!m) return
		if (m.ws.readyState !== m.ws.OPEN) return
		m.ws.send(JSON.stringify(ev))
	}

	broadcastMembers(): void {
		this.broadcast({ t: 'members', members: this.memberViews() })
	}

	welcomeFor(member: Member): ServerEvent {
		return {
			t: 'welcome',
			you: { id: member.id, name: member.name },
			room: { name: this.name },
			members: this.memberViews(),
			speaker: this.speakerView(),
			cfg: {
				sampleRate: 16000,
				frameMs: 20,
				maxSpeakMs: this.cfg.maxSpeakMs,
				halfDuplex: true,
				speakMode: this.cfg.speakMode,
			},
		}
	}

	dispose(): void {
		if (this.speakTimer) clearTimeout(this.speakTimer)
		this.speakTimer = null
		this.members.clear()
		this.speakerId = null
	}
}
