import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ConnStatus, MemberView, RoomConfigView } from '../types'

type Props = {
	roomName: string
	members: MemberView[]
	speaker: { id: string; name: string } | null
	myId: string
	speaking: boolean
	status: ConnStatus
	cfg: RoomConfigView | null
	toast: string
	localLevel: number
	remoteLevel: number
	onToggleSpeak: (on: boolean) => Promise<boolean>
	onVolume: (v: number) => void
	onGain: (v: number) => void
	onLeave: () => void
	onForget: () => void
}

const STATUS_TEXT: Record<ConnStatus, string> = {
	idle: '未连接',
	connecting: '连接中…',
	online: '已连接',
	reconnecting: '断线，重连中…',
	closed: '已断开',
}

export default function RoomPage(p: Props) {
	const [settingsOpen, setSettingsOpen] = useState(false)
	const [volume, setVolume] = useState(100)
	const [gain, setGain] = useState(100)
	const pressRef = useRef(false)

	const handleDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
		e.preventDefault()
		if (pressRef.current) return
		pressRef.current = true
		try {
			e.currentTarget.setPointerCapture(e.pointerId)
		} catch {
			/* ignore */
		}
		navigator.vibrate?.(30)
		void p.onToggleSpeak(true)
	}

	const handleUp = () => {
		if (!pressRef.current) return
		pressRef.current = false
		navigator.vibrate?.(15)
		void p.onToggleSpeak(false)
	}

	const others = p.members.filter((m) => m.id !== p.myId)
	const speakerName = p.speaker ? (p.speaker.id === p.myId ? '我' : p.speaker.name) : null

	return (
		<div className="screen room">
			<header className="room-header">
				<div className="room-title">
					<strong>{p.roomName}</strong>
					<span className="muted small">· {p.members.length} 人在线</span>
				</div>
				<div className={`conn conn-${p.status}`}>{STATUS_TEXT[p.status]}</div>
			</header>

			<section className="members">
				{others.length === 0 ? (
					<p className="muted small">只有你一个人在房间里。叫家人来一起说话吧。</p>
				) : (
					<ul>
						{others.map((m) => (
							<li key={m.id} className={m.speaking ? 'speaking' : ''}>
								<span className="avatar" aria-hidden="true">
									{m.name.slice(0, 1)}
								</span>
								<span className="name">{m.name}</span>
								{m.speaking && <span className="badge">说话中</span>}
								{m.muted && <span className="badge muted-badge">已静音</span>}
							</li>
						))}
					</ul>
				)}
			</section>

			<div className="status-line">
				{speakerName ? (
					<span className="speaking-text">
						{speakerName === '我' ? '你正在说话' : `${speakerName} 正在说话…`}
					</span>
				) : (
					<span className="muted small">按住下方按钮说话</span>
				)}
			</div>

			<div className="ptt-zone">
				<button
					type="button"
					className={`ptt ${p.speaking ? 'active' : ''}`}
					onPointerDown={handleDown}
					onPointerUp={handleUp}
					onPointerCancel={handleUp}
					onLostPointerCapture={handleUp}
					onContextMenu={(e) => e.preventDefault()}
					aria-label="按住说话"
				>
					<span className="ptt-label">{p.speaking ? '松开结束' : '按住说话'}</span>
				</button>
				<div className="level-bars" aria-hidden="true">
				<div className="level local" style={{ transform: `scaleX(${Math.min(1, p.localLevel * 1.6)})` }} />
				<div className="level remote" style={{ transform: `scaleX(${Math.min(1, p.remoteLevel * 1.6)})` }} />
				</div>
			</div>

			<footer className="room-footer">
				<button className="icon-btn" onClick={() => setSettingsOpen(true)} aria-label="设置">
					⚙
				</button>
				<button className="icon-btn" onClick={p.onLeave} aria-label="离开房间">
					⏻
				</button>
			</footer>

			{p.toast && <div className="toast">{p.toast}</div>}

			{settingsOpen && (
				<div className="sheet-backdrop" onClick={() => setSettingsOpen(false)}>
					<div className="sheet" onClick={(e) => e.stopPropagation()}>
						<h2>设置</h2>

						<label className="field">
							<span>收听音量 · {volume}%</span>
							<input
								type="range"
								min={0}
								max={100}
								value={volume}
								onChange={(e) => {
									const v = Number(e.target.value)
									setVolume(v)
									p.onVolume(v / 100)
								}}
							/>
						</label>

						<label className="field">
							<span>麦克风增益 · {gain}%</span>
							<input
								type="range"
								min={50}
								max={200}
								value={gain}
								onChange={(e) => {
									const v = Number(e.target.value)
									setGain(v)
									p.onGain(v / 100)
								}}
							/>
						</label>

						<p className="muted small">
							半双工：同一时刻只有一个人能说话{'\n'}发言上限 {Math.round((p.cfg?.maxSpeakMs ?? 60000) / 1000)} 秒
						</p>

						<button className="primary-btn" onClick={() => setSettingsOpen(false)}>
							完成
						</button>
						<button
							className="link-btn"
							onClick={() => {
								setSettingsOpen(false)
								p.onForget()
							}}
						>
							清除本机昵称和口令
						</button>
					</div>
				</div>
			)}
		</div>
	)
}
