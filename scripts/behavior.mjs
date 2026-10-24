#!/usr/bin/env node
/**
 * 服务端行为补充测试：抢麦模式与发言超时。
 *
 *   SPEAK_MODE=exclusive MAX_SPEAK_MS=1500 node server/dist/index.js
 *   node scripts/behavior.mjs
 *
 * 可用环境变量：
 *   SMOKE_URL   默认 ws://127.0.0.1:8443/ws
 *   FAMILY_CODE 默认 test1234
 *   MODE        期望的抢麦模式: preempt | exclusive（默认按服务端实际行为自动判断）
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(path.resolve(__dirname, '..', 'server', 'package.json'))
const WebSocket = require('ws')

const URL = process.env.SMOKE_URL || 'ws://127.0.0.1:8443/ws'
const CODE = process.env.FAMILY_CODE || 'test1234'
const MODE = process.env.MODE || ''

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function connect(name) {
	const ws = new WebSocket(URL)
	const c = { ws, name, events: [], speaker: undefined, welcome: null }
	c.send = (ev) => ws.send(JSON.stringify(ev))
	c.waitFor = async (pred, timeout = 5000) => {
		const t0 = Date.now()
		for (;;) {
			const hit = c.events.find(pred)
			if (hit) return hit
			if (Date.now() - t0 > timeout) throw new Error(`等待超时: ${name}`)
			await sleep(20)
		}
	}
	ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, code: CODE })))
	ws.on('message', (data, isBinary) => {
		if (isBinary) return
		const ev = JSON.parse(data.toString())
		c.events.push(ev)
		if (ev.t === 'welcome') c.welcome = ev
		if (ev.t === 'speaker') c.speaker = ev.id
	})
	ws.on('error', () => {})
	return c
}

async function main() {
	console.log(`目标: ${URL}`)

	const a = connect('A')
	await a.waitFor((e) => e.t === 'welcome')
	const mode = MODE || a.welcome.cfg.speakMode
	const maxSpeakMs = a.welcome.cfg.maxSpeakMs
	console.log(`服务端模式: speakMode=${mode} maxSpeakMs=${maxSpeakMs}`)

	const b = connect('B')
	await b.waitFor((e) => e.t === 'welcome')
	await sleep(200)

	// ---------- 抢麦模式 ----------
	console.log(`\n\x1b[1m抢麦模式 (${mode})\x1b[0m`)
	a.send({ t: 'speak', on: true })
	await sleep(300)
	ok('A 取得麦权', a.speaker === a.welcome.you.id)

	b.send({ t: 'speak', on: true })
	await sleep(400)

	if (mode === 'exclusive') {
		ok('exclusive 模式下 B 拿不到麦权', b.speaker === a.welcome.you.id, `speaker=${b.speaker}`)
		const err = b.events.find((e) => e.t === 'error' && e.code === 'FLOOR_BUSY')
		ok('B 收到 FLOOR_BUSY 提示', !!err)
		ok('A 的麦权未受影响', a.speaker === a.welcome.you.id)
	} else {
		ok('preempt 模式下 B 抢到麦权', b.speaker === b.welcome.you.id, `speaker=${b.speaker}`)
		ok('A 失去麦权', a.speaker === b.welcome.you.id)
	}

	// ---------- 发言超时自动放麦 ----------
	console.log(`\n\x1b[1m发言超时自动放麦 (${maxSpeakMs}ms)\x1b[0m`)
	const holder = mode === 'exclusive' ? a : b
	holder.send({ t: 'speak', on: true })
	await sleep(300)
	const before = holder.speaker
	ok('超时前持麦', before === holder.welcome.you.id)

	await sleep(maxSpeakMs + 800)
	ok('超时后麦权自动释放', holder.speaker === null, `speaker=${holder.speaker}`)
	ok('其他端也看到麦权清空', a.speaker === null && b.speaker === null)

	// ---------- 断线自动释放 ----------
	console.log(`\n\x1b[1m断线自动放麦\x1b[0m`)
	a.send({ t: 'speak', on: true })
	await sleep(300)
	ok('A 重新取得麦权', a.speaker === a.welcome.you.id)
	a.ws.close()
	await sleep(500)
	ok('A 断线后麦权自动释放', b.speaker === null, `speaker=${b.speaker}`)

	b.ws.close()
	await sleep(200)

	console.log(`\n\x1b[1m结果: ${passed} 通过, ${failed} 失败\x1b[0m`)
	process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
	console.error('\n测试异常终止:', err)
	process.exit(1)
})
