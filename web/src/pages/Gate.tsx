import { useState, type FormEvent } from 'react'
import type { Creds } from '../types'

type Props = {
	error: string
	initial: Creds | null
	onEnter: (creds: Creds) => void | Promise<void>
	onForget: () => void
}

export default function Gate({ error, initial, onEnter, onForget }: Props) {
	const [name, setName] = useState(initial?.name ?? '')
	const [code, setCode] = useState(initial?.code ?? '')
	const [busy, setBusy] = useState(false)

	const submit = async (e: FormEvent) => {
		e.preventDefault()
		if (busy) return
		setBusy(true)
		try {
			await onEnter({ name: name.trim(), code })
		} finally {
			setBusy(false)
		}
	}

	return (
		<div className="screen gate">
			<div className="gate-card">
				<h1 className="brand">家庭对讲</h1>
				<p className="muted small">连上家里的 Wi-Fi，输入昵称和家庭口令</p>

				<form onSubmit={submit}>
					<label className="field">
						<span>昵称</span>
						<input
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="妈妈"
							autoComplete="nickname"
							maxLength={20}
							required
							autoFocus
						/>
					</label>

					<label className="field">
						<span>家庭口令</span>
						<input
							type="password"
							value={code}
							onChange={(e) => setCode(e.target.value)}
							placeholder="••••"
							autoComplete="current-password"
							required
						/>
					</label>

					{error && <p className="error">{error}</p>}

					<button className="primary-btn" type="submit" disabled={busy || !name.trim()}>
						{busy ? '进入中…' : '进 入'}
					</button>
				</form>

				{initial && (
					<button className="link-btn" onClick={onForget} type="button">
						清除本机保存的昵称和口令
					</button>
				)}
			</div>
		</div>
	)
}
