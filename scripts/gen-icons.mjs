#!/usr/bin/env node
/**
 * 生成 PWA 图标（纯 Node，不依赖任何图片素材或第三方库）
 *
 *   node scripts/gen-icons.mjs
 *
 * 输出：
 *   web/public/icons/icon-192.png
 *   web/public/icons/icon-512.png
 *   web/public/icons/maskable-512.png
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '..', 'web', 'public', 'icons')

// ---------- PNG 编码 ----------

const CRC_TABLE = (() => {
	const t = new Int32Array(256)
	for (let n = 0; n < 256; n++) {
		let c = n
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		t[n] = c
	}
	return t
})()

function crc32(buf) {
	let c = 0xffffffff
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
	const len = Buffer.alloc(4)
	len.writeUInt32BE(data.length, 0)
	const typeBuf = Buffer.from(type, 'ascii')
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
	return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(size, rgba) {
	const ihdr = Buffer.alloc(13)
	ihdr.writeUInt32BE(size, 0)
	ihdr.writeUInt32BE(size, 4)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 6 // color type: RGBA
	const raw = Buffer.alloc((size * 4 + 1) * size)
	for (let y = 0; y < size; y++) {
		const rowStart = y * (size * 4 + 1)
		raw[rowStart] = 0 // filter: none
		for (let x = 0; x < size; x++) {
			const src = (y * size + x) * 4
			const dst = rowStart + 1 + x * 4
			raw[dst] = rgba[src]
			raw[dst + 1] = rgba[src + 1]
			raw[dst + 2] = rgba[src + 2]
			raw[dst + 3] = rgba[src + 3]
		}
	}
	const idat = deflateSync(raw, { level: 9 })
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', idat),
		chunk('IEND', Buffer.alloc(0)),
	])
}

// ---------- 简易光栅器 ----------

function createCanvas(size) {
	return { size, data: new Float32Array(size * size * 4) }
}

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
	const qx = Math.abs(px - cx) - (hw - r)
	const qy = Math.abs(py - cy) - (hh - r)
	return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r
}

function sdCapsule(px, py, x0, y0, x1, y1, r) {
	const dx = x1 - x0
	const dy = y1 - y0
	const len2 = dx * dx + dy * dy || 1
	let t = ((px - x0) * dx + (py - y0) * dy) / len2
	t = Math.max(0, Math.min(1, t))
	return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy)) - r
}

function fill(cv, sdf, colorAt) {
	const { size, data } = cv
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const d = sdf(x + 0.5, y + 0.5)
			const cov = Math.max(0, Math.min(1, 0.5 - d))
			if (cov <= 0) continue
			const [r, g, b, a] = colorAt(x + 0.5, y + 0.5)
			const i = (y * size + x) * 4
			const sa = a * cov
			const da = data[i + 3]
			const outA = sa + da * (1 - sa)
			if (outA <= 0) continue
			data[i] = (r * sa + data[i] * da * (1 - sa)) / outA
			data[i + 1] = (g * sa + data[i + 1] * da * (1 - sa)) / outA
			data[i + 2] = (b * sa + data[i + 2] * da * (1 - sa)) / outA
			data[i + 3] = outA
		}
	}
}

function toBytes(cv) {
	const out = Buffer.alloc(cv.size * cv.size * 4)
	for (let i = 0; i < out.length; i++) {
		const v = Math.round(Math.max(0, Math.min(1, cv.data[i])) * 255)
		out[i] = v
	}
	return out
}

// ---------- 图标绘制 ----------

function drawIcon(size, { maskable = false } = {}) {
	const cv = createCanvas(size)
	const u = size / 512 // 以 512 为设计基准

	// 背景
	if (maskable) {
		// maskable 需要满幅（平台会自己裁形状），安全区只保留中间 80%
		fill(
			cv,
			() => -1,
			(_x, y) => {
				const t = y / size
				return [lerp(37, 11, t) / 255, lerp(99, 16, t) / 255, lerp(235, 32, t) / 255, 1]
			},
		)
	} else {
		const pad = 16 * u
		fill(
			cv,
			(px, py) => sdRoundRect(px, py, size / 2, size / 2, size / 2 - pad, size / 2 - pad, 104 * u),
			(_x, y) => {
				const t = y / size
				return [lerp(37, 11, t) / 255, lerp(99, 16, t) / 255, lerp(235, 32, t) / 255, 1]
			},
		)
	}

	// 对讲音波：4 根高度不等的胶囊
	const scale = maskable ? 0.62 : 0.78
	const barW = 44 * u * scale
	const gap = 30 * u * scale
	const heights = [110, 190, 150, 96].map((h) => h * u * scale)
	const totalW = barW * 4 + gap * 3
	const startX = (size - totalW) / 2 + barW / 2
	const baseY = size / 2 + 96 * u * scale
	const radius = barW / 2

	for (let i = 0; i < 4; i++) {
		const cx = startX + i * (barW + gap)
		const h = heights[i]
		fill(
			cv,
			(px, py) => sdCapsule(px, py, cx, baseY, cx, baseY - h, radius),
			(_x, _y) => [248 / 255, 250 / 255, 252 / 255, 1],
		)
	}

	return encodePng(size, toBytes(cv))
}

function lerp(a, b, t) {
	return a + (b - a) * t
}

// ---------- 输出 ----------

mkdirSync(OUT_DIR, { recursive: true })

const targets = [
	['icon-192.png', drawIcon(192)],
	['icon-512.png', drawIcon(512)],
	['maskable-512.png', drawIcon(512, { maskable: true })],
]

for (const [name, buf] of targets) {
	const p = path.join(OUT_DIR, name)
	writeFileSync(p, buf)
	console.log(`生成 ${p} (${buf.length} 字节)`)
}
