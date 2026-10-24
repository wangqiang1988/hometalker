import { readFileSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createLogger } from './log.js'

const log = createLogger('static')

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	'.txt': 'text/plain; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
}

const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json)|image\/svg)/

type CacheEntry = { body: Buffer; gz: Buffer; etag: string; mtimeMs: number; size: number }

export class StaticFiles {
	private readonly root: string
	private readonly cache = new Map<string, CacheEntry>()

	constructor(root: string) {
		this.root = path.resolve(root)
	}

	/** 返回 true 表示该请求已被处理 */
	serve(req: IncomingMessage, res: ServerResponse): boolean {
		if (req.method !== 'GET' && req.method !== 'HEAD') return false

		const url = new URL(req.url ?? '/', 'http://localhost')
		let pathname = decodeURIComponent(url.pathname)
		if (pathname.endsWith('/')) pathname += 'index.html'

		let filePath = this.resolve(pathname)
		let isFallback = false

		if (!filePath) {
			return false
		}

		if (!this.exists(filePath) && !path.extname(pathname)) {
			// SPA 回退：未知路径一律返回 index.html
			filePath = this.resolve('/index.html')
			isFallback = true
			if (!filePath || !this.exists(filePath)) return false
		} else if (!this.exists(filePath)) {
			return false
		}

		const ext = path.extname(filePath).toLowerCase()
		const type = MIME[ext] ?? 'application/octet-stream'
		const entry = this.load(filePath)

		const headers: Record<string, string> = {
			'Content-Type': type,
			'X-Content-Type-Options': 'nosniff',
		}

		if (pathname.startsWith('/assets/')) {
			headers['Cache-Control'] = 'public, max-age=31536000, immutable'
		} else {
			// index.html / sw.js / 图标等：始终回源校验，保证更新能立刻生效
			headers['Cache-Control'] = 'no-cache'
		}
		headers['ETag'] = entry.etag

		if (req.headers['if-none-match'] === entry.etag) {
			res.writeHead(304, headers)
			res.end()
			return true
		}

		const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')
		if (acceptsGzip && COMPRESSIBLE.test(type)) {
			headers['Content-Encoding'] = 'gzip'
			headers['Vary'] = 'Accept-Encoding'
			headers['Content-Length'] = String(entry.gz.length)
			res.writeHead(200, headers)
			res.end(req.method === 'HEAD' ? undefined : entry.gz)
		} else {
			headers['Content-Length'] = String(entry.body.length)
			res.writeHead(200, headers)
			res.end(req.method === 'HEAD' ? undefined : entry.body)
		}

		if (isFallback) log.debug(`SPA 回退 ${pathname} -> index.html`)
		return true
	}

	/** 解析为绝对路径，并阻止路径穿越（..） */
	private resolve(pathname: string): string | null {
		const target = path.resolve(this.root, '.' + pathname)
		if (target !== this.root && !target.startsWith(this.root + path.sep)) return null
		return target
	}

	private exists(p: string): boolean {
		try {
			return statSync(p).isFile()
		} catch {
			return false
		}
	}

	private load(filePath: string): CacheEntry {
		// 用 mtime + size 校验缓存：重新部署后静态文件变化能立即生效，
		// 否则客户端会拿到指向已删除 hash 资源的旧 index.html，直接白屏。
		const st = statSync(filePath)
		const hit = this.cache.get(filePath)
		if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
			return hit
		}
		const body = readFileSync(filePath)
		const gz = gzipSync(body, { level: 6 })
		const etag = `W/"${body.length.toString(16)}-${body.subarray(0, 16).toString('hex')}"`
		const entry: CacheEntry = { body, gz, etag, mtimeMs: st.mtimeMs, size: st.size }
		this.cache.set(filePath, entry)
		return entry
	}
}
