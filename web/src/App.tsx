import { useCallback, useEffect, useRef, useState } from 'react'
import { RoomConnection } from './net/ws'
import { AudioLink } from './audio/audio'
import type { ConnStatus, Creds, MemberView, RoomConfigView, ServerEvent } from './types'
import Gate from './pages/Gate'
import RoomPage from './pages/RoomPage'

const STORAGE_KEY = 'footalker.creds'

function loadCreds(): Creds | null {
	try {
		const raw = localStorage.getItem(STORAGE_KEY)
		if (!raw) return null
		const v = JSON.parse(raw) as Partial<Creds>
		if (typeof v.name === 'string' && typeof v.code === 'string') {
			return { name: v.name, code: v.code }
		}
	} catch {
		/* ignore */
	}
	return null
}

function saveCreds(c: Creds): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(c))
	} catch {
		/* ignore */
	}
}

type Phase = 'gate' | 'connecting' | 'room'

export default function App() {
	const [phase, setPhase] = useState<Phase>('gate')
	const [gateError, setGateError] = useState('')
	const [status, setStatus] = useState<ConnStatus>('idle')
	const [members, setMembers] = useState<MemberView[]>([])
	const [speaker, setSpeaker] = useState<{ id: string; name: string } | null>(null)
	const [roomName, setRoomName] = useState('home')
	const [cfg, setCfg] = useState<RoomConfigView | null>(null)
	const [myId, setMyId] = useState('')
	const [speaking, setSpeaking] = useState(false)
	const [toast, setToast] = useState('')
	const [localLevel, setLocalLevel] = useState(0)
	const [remoteLevel, setRemoteLevel] = useState(0)

	const connRef = useRef<RoomConnection | null>(null)
	const audioRef = useRef<AudioLink | null>(null)
	const credsRef = useRef<Creds | null>(null)
	const myIdRef = useRef('')
	const speakerRef = useRef<string | null>(null)
	const speakingRef = useRef(false)
	const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	const showToast = useCallback((msg: string) => {
		setToast(msg)
		if (toastTimer.current) clearTimeout(toastTimer.current)
		toastTimer.current = setTimeout(() => setToast(''), 3200)
	}, [])

	const stopSpeaking = useCallback((notifyServer: boolean) => {
		if (!speakingRef.current) return
		speakingRef.current = false
		setSpeaking(false)
		if (notifyServer) connRef.current?.send({ t: 'speak', on: false })
		audioRef.current?.stopCapture()
	}, [])

	// ---------- 连接 ----------
	const connect = useCallback(
		(creds: Creds, audio: AudioLink) => {
			connRef.current?.disconnect()
			credsRef.current = creds

			const conn = new RoomConnection()
			connRef.current = conn

			conn.onStatus = (s) => setStatus(s)

			conn.onEvent = (ev: ServerEvent) => {
				switch (ev.t) {
					case 'welcome': {
						myIdRef.current = ev.you.id
						setMyId(ev.you.id)
						setRoomName(ev.room.name)
						setMembers(ev.members)
						setCfg(ev.cfg)
						setSpeaker(ev.speaker)
						speakerRef.current = ev.speaker?.id ?? null
						setPhase('room')
						// 只有真正进房成功才记住昵称和口令，避免把输错的口令存到本机
						if (credsRef.current) saveCreds(credsRef.current)
						break
					}
					case 'members':
						setMembers(ev.members)
						break
					case 'speaker': {
						setSpeaker(ev.id ? { id: ev.id, name: ev.name ?? '' } : null)
						speakerRef.current = ev.id
						// 自己丢了麦权（被抢占 / 超时 / 对方松手）→ 立即停止采集
						if (speakingRef.current && ev.id !== myIdRef.current) {
							stopSpeaking(false)
						}
						break
					}
					case 'error': {
						if (ev.code === 'PONG') break
						if (ev.code === 'SPEAK_TIMEOUT') {
							stopSpeaking(false)
							showToast(ev.message || '发言超时，已自动放麦')
							break
						}
						if (ev.code === 'FLOOR_BUSY') {
							showToast(ev.message || '麦被占用了')
							break
						}
						// 致命错误：口令错 / 房间满 / 昵称缺失
						setGateError(ev.message || '无法进入房间')
						setPhase('gate')
						conn.disconnect()
						break
					}
				}
			}

			conn.onClose = (code) => {
				if (code === 4401) {
					setGateError('家庭口令不正确')
					setPhase('gate')
				}
			}

			conn.onBinary = (data) => audio.pushFrame(data)

			conn.connect(creds)
			setPhase('connecting')
		},
		[showToast, stopSpeaking],
	)

	// ---------- 进入房间（必须在用户手势里执行） ----------
	const handleEnter = useCallback(
		async (creds: Creds) => {
			setGateError('')

			let audio = audioRef.current
			if (!audio) {
				audio = new AudioLink({
					onFrame: (buf) => connRef.current?.sendBinary(buf),
					onLocalLevel: setLocalLevel,
					onRemoteLevel: setRemoteLevel,
				})
				audioRef.current = audio
			}
			// iOS：AudioContext 必须在用户手势里创建/恢复
			await audio.unlock()
			connect(creds, audio)
		},
		[connect],
	)

	const handleLeave = useCallback(() => {
		stopSpeaking(true)
		connRef.current?.disconnect()
		connRef.current = null
		setPhase('gate')
		setStatus('idle')
		setMembers([])
		setSpeaker(null)
		speakerRef.current = null
	}, [stopSpeaking])

	const handleForget = useCallback(() => {
		try {
			localStorage.removeItem(STORAGE_KEY)
		} catch {
			/* ignore */
		}
		handleLeave()
		setGateError('')
	}, [handleLeave])

	// ---------- 发言 ----------
	const toggleSpeak = useCallback(
		async (on: boolean): Promise<boolean> => {
			const conn = connRef.current
			const audio = audioRef.current
			if (!conn || !audio) return false

			if (!on) {
				stopSpeaking(true)
				return true
			}

			if (speakingRef.current) return true

			// 先置位：如果用户在麦克风授权弹窗期间松手，下面的 on=false 分支会把它清掉
			speakingRef.current = true

			try {
				await audio.startCapture()
			} catch (err) {
				speakingRef.current = false
				setSpeaking(false)
				const msg =
					err instanceof Error && err.name === 'NotAllowedError'
						? '麦克风权限被拒绝，请在浏览器设置里允许后重试'
						: err instanceof Error
							? err.message
							: '无法开启麦克风'
				showToast(msg)
				return false
			}

			// 授权期间用户已经松手了
			if (!speakingRef.current) {
				audio.stopCapture()
				return false
			}

			setSpeaking(true)
			conn.send({ t: 'speak', on: true })
			return true
		},
		[showToast, stopSpeaking],
	)

	// ---------- 屏幕常亮 ----------
	useEffect(() => {
		if (!speaking) return
		let lock: import('./wakelock').WakeLockSentinelLike | null = null
		let disposed = false

		const request = () => {
			if (!navigator.wakeLock) return
			navigator.wakeLock
				.request('screen')
				.then((s) => {
					if (disposed) {
						s.release().catch(() => {})
						return
					}
					lock = s
				})
				.catch(() => {})
		}

		request()
		const onVisible = () => {
			if (document.visibilityState === 'visible' && !lock) request()
		}
		document.addEventListener('visibilitychange', onVisible)

		return () => {
			disposed = true
			document.removeEventListener('visibilitychange', onVisible)
			lock?.release().catch(() => {})
		}
	}, [speaking])

	// ---------- 回到前台立即重连 ----------
	useEffect(() => {
		const onVisible = () => {
			if (document.visibilityState === 'visible') {
				connRef.current?.reconnectNow()
				audioRef.current?.resume()
			}
		}
		document.addEventListener('visibilitychange', onVisible)
		return () => document.removeEventListener('visibilitychange', onVisible)
	}, [])

	useEffect(() => {
		return () => {
			stopSpeaking(true)
			connRef.current?.disconnect()
			audioRef.current?.close()
		}
	}, [stopSpeaking])

	if (phase === 'gate') {
		return (
			<Gate
				error={gateError}
				initial={loadCreds()}
				onEnter={handleEnter}
				onForget={handleForget}
			/>
		)
	}

	if (phase === 'connecting') {
		return (
			<div className="screen centered">
				<div className="spinner" aria-hidden="true" />
				<p className="muted">正在连接…</p>
				<button className="link-btn" onClick={handleLeave}>
					取消
				</button>
			</div>
		)
	}

	return (
		<RoomPage
			roomName={roomName}
			members={members}
			speaker={speaker}
			myId={myId}
			speaking={speaking}
			status={status}
			cfg={cfg}
			toast={toast}
			localLevel={localLevel}
			remoteLevel={remoteLevel}
			onToggleSpeak={toggleSpeak}
			onVolume={(v) => audioRef.current?.setPlaybackVolume(v)}
			onGain={(v) => audioRef.current?.setCaptureGain(v)}
			onLeave={handleLeave}
			onForget={handleForget}
		/>
	)
}
