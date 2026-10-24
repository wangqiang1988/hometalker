import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { setLogLevel, type LogLevel } from './log.js'

export type SpeakMode = 'preempt' | 'exclusive'

export type Config = {
	port: number
	familyCode: string
	roomName: string
	maxMembers: number
	maxSpeakMs: number
	speakMode: SpeakMode
	publicDir: string
	logLevel: LogLevel
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function env(name: string): string | undefined {
	const v = process.env[name]
	if (v === undefined) return undefined
	const t = v.trim()
	return t.length > 0 ? t : undefined
}

function intEnv(name: string, fallback: number): number {
	const raw = env(name)
	if (raw === undefined) return fallback
	const n = Number.parseInt(raw, 10)
	if (!Number.isFinite(n) || n <= 0) {
		throw new Error(`环境变量 ${name} 必须是正整数，当前值: ${raw}`)
	}
	return n
}

export function loadConfig(): Config {
	const familyCode = env('FAMILY_CODE')
	if (!familyCode) {
		throw new Error(
			'缺少环境变量 FAMILY_CODE（家庭口令）。\n' +
				'请在 .env 中设置后重试，例如 FAMILY_CODE=你的口令\n' +
				'（故意不提供"默认空口令"模式，避免忘记设口令导致任何人都能进房间收听。）',
		)
	}
	if (familyCode.length < 4) {
		throw new Error('FAMILY_CODE 至少 4 个字符，太短容易被猜到。')
	}

	const speakModeRaw = (env('SPEAK_MODE') ?? 'preempt').toLowerCase()
	if (speakModeRaw !== 'preempt' && speakModeRaw !== 'exclusive') {
		throw new Error(`SPEAK_MODE 只能是 preempt 或 exclusive，当前值: ${speakModeRaw}`)
	}

	const logLevelRaw = (env('LOG_LEVEL') ?? 'info').toLowerCase() as LogLevel
	setLogLevel(logLevelRaw)

	return {
		port: intEnv('PORT', 8443),
		familyCode,
		roomName: env('ROOM_NAME') ?? 'home',
		maxMembers: intEnv('MAX_MEMBERS', 12),
		maxSpeakMs: intEnv('MAX_SPEAK_MS', 60_000),
		speakMode: speakModeRaw,
		publicDir: env('PUBLIC_DIR') ?? path.resolve(__dirname, '..', 'public'),
		logLevel: logLevelRaw,
	}
}
