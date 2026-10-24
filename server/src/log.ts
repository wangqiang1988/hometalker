export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

let current: LogLevel = 'info'

export function setLogLevel(level: LogLevel): void {
	current = level
}

function ts(): string {
	const d = new Date()
	const p = (n: number, w = 2) => String(n).padStart(w, '0')
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function emit(level: LogLevel, scope: string, msg: string, extra?: unknown): void {
	if (LEVELS[level] < LEVELS[current]) return
	const line = `${ts()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`
	if (extra === undefined) console.log(line)
	else console.log(line, extra)
}

export function createLogger(scope: string) {
	return {
		debug: (msg: string, extra?: unknown) => emit('debug', scope, msg, extra),
		info: (msg: string, extra?: unknown) => emit('info', scope, msg, extra),
		warn: (msg: string, extra?: unknown) => emit('warn', scope, msg, extra),
		error: (msg: string, extra?: unknown) => emit('error', scope, msg, extra),
	}
}

export type Logger = ReturnType<typeof createLogger>
