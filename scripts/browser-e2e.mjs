#!/usr/bin/env node
/**
 * 真实浏览器端到端验证（Chrome + fake audio device）
 *
 * 验证整条音频链路：
 *   getUserMedia → capture worklet → WebSocket 二进制 → 服务端转发 → playback worklet → 扬声器
 *
 * 用法：
 *   FAMILY_CODE=test1234 node server/dist/index.js &
 *   node scripts/browser-e2e.mjs
 */
let puppeteer
try {
	puppeteer = (await import('puppeteer-core')).default
} catch {
	console.error(
		'这个脚本需要 puppeteer-core。请先安装：\n  npm i -D puppeteer-core\n（或在任意目录安装后用 NODE_PATH 指向它）',
	)
	process.exit(1)
}

const TARGET = process.env.E2E_URL || 'http://127.0.0.1:8443'
const CODE = process.env.FAMILY_CODE || 'test1234'
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome'

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

async function enterRoom(page, name) {
	await page.waitForSelector('input[type="text"]', { timeout: 15000 })
	await page.evaluate(() => localStorage.removeItem('footalker.creds'))
	// 三击全选后再输入，确保覆盖掉已填内容
	await page.click('input[type="text"]', { clickCount: 3 })
	await page.type('input[type="text"]', name)
	await page.click('input[type="password"]', { clickCount: 3 })
	await page.type('input[type="password"]', CODE)
	await page.click('.primary-btn')
	await page.waitForSelector('.ptt', { timeout: 15000 })
}

// 读取某条电平条当前的 scaleX（0 表示无声）
async function readLevel(page, cls) {
	return page.evaluate((c) => {
		const el = document.querySelector(c)
		if (!el) return -1
		const m = /scaleX\(([\d.]+)\)/.exec(el.getAttribute('style') || '')
		return m ? Number(m[1]) : -1
	}, cls)
}

async function maxLevel(page, cls, durationMs) {
	const end = Date.now() + durationMs
	let max = -1
	while (Date.now() < end) {
		const v = await readLevel(page, cls)
		if (v > max) max = v
		await sleep(60)
	}
	return max
}

async function main() {
	const browser = await puppeteer.launch({
		executablePath: CHROME,
		headless: 'new',
		args: [
			'--no-sandbox',
			'--disable-setuid-sandbox',
			'--disable-dev-shm-usage',
			'--use-fake-ui-for-media-stream',
			'--use-fake-device-for-media-stream',
			'--autoplay-policy=no-user-gesture-required',
			'--enable-features=SharedArrayBuffer',
		],
	})

	const ctx = browser.defaultBrowserContext()
	await ctx.overridePermissions(new URL(TARGET).origin, ['microphone'])

	console.log(`目标: ${TARGET}`)

	// ---------- 门禁页 ----------
	console.log('\n\x1b[1m门禁页\x1b[0m')
	const pa = await browser.newPage()
	pa.on('console', (m) => {
		if (m.type() === 'error') console.log('    [A console.error]', m.text())
	})
	pa.on('pageerror', (e) => console.log('    [A pageerror]', e.message))
	await pa.goto(TARGET, { waitUntil: 'networkidle2' })
	ok('页面加载', await pa.$('.gate-card') !== null)
	ok('显示门禁表单', await pa.$('input[type="password"]') !== null)

	// 错误口令应被拒绝
	await pa.click('input[type="text"]', { clickCount: 3 })
	await pa.type('input[type="text"]', '入侵者')
	await pa.click('input[type="password"]', { clickCount: 3 })
	await pa.type('input[type="password"]', 'wrong-code')
	await pa.click('.primary-btn')
	await pa.waitForFunction(() => document.querySelector('.error') !== null, { timeout: 8000 })
	ok(
		'错误口令被拒绝并提示',
		(await pa.$eval('.error', (e) => e.textContent || '')).includes('口令'),
		await pa.$eval('.error', (e) => e.textContent || ''),
	)
	ok(
		'口令错误时不会把口令存到本机',
		await pa.evaluate(() => localStorage.getItem('footalker.creds') === null),
	)

	// ---------- 两个客户端进房 ----------
	console.log('\n\x1b[1m加入房间\x1b[0m')
	await pa.goto(TARGET, { waitUntil: 'networkidle2' })
	await enterRoom(pa, '妈妈')

	const pb = await browser.newPage()
	pb.on('pageerror', (e) => console.log('    [B pageerror]', e.message))
	await pb.goto(TARGET, { waitUntil: 'networkidle2' })
	await enterRoom(pb, '爸爸')

	await sleep(500)
	ok('A 看到家人在列表里', (await pa.$$eval('.members li .name', (n) => n.map((x) => x.textContent))).includes('爸爸'))
	ok('B 看到家人在列表里', (await pb.$$eval('.members li .name', (n) => n.map((x) => x.textContent))).includes('妈妈'))
	ok('顶部显示 2 人在线', (await pa.$eval('.room-title', (e) => e.textContent || '')).includes('2'))

	// ---------- 音频链路 ----------
	console.log('\n\x1b[1m音频链路\x1b[0m')
	const box = await pa.$eval('.ptt', (el) => {
		const r = el.getBoundingClientRect()
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
	})

	// A 按住说话
	await pa.mouse.move(box.x, box.y)
	await pa.mouse.down()
	await sleep(700)

	ok('A 进入发言状态', await pa.$eval('.ptt', (e) => e.className.includes('active')))
	ok('A 状态栏提示正在说话', (await pa.$eval('.status-line', (e) => e.textContent || '')).includes('正在说话'))

	const localMax = await maxLevel(pa, '.level.local', 900)
	ok('A 采集到麦克风信号', localMax > 0, `local level=${localMax}`)

	const remoteMax = await maxLevel(pb, '.level.remote', 1500)
	ok('B 收到 A 的音频并播放', remoteMax > 0, `remote level=${remoteMax}`)

	ok('B 看到 A 正在说话', (await pb.$eval('.status-line', (e) => e.textContent || '')).includes('妈妈'))

	// 松手
	await pa.mouse.up()
	await sleep(400)
	ok('松手后 A 退出发言状态', !(await pa.$eval('.ptt', (e) => e.className.includes('active'))))

	const remoteAfter = await maxLevel(pb, '.level.remote', 800)
	ok('松手后 B 不再收到音频', remoteAfter === 0, `remote level=${remoteAfter}`)

	// ---------- 抢麦 ----------
	console.log('\n\x1b[1m抢麦\x1b[0m')
	const boxB = await pb.$eval('.ptt', (el) => {
		const r = el.getBoundingClientRect()
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
	})
	await pb.mouse.move(boxB.x, boxB.y)
	await pb.mouse.down()
	await sleep(800)
	ok('B 抢占成功进入发言状态', await pb.$eval('.ptt', (e) => e.className.includes('active')))
	ok('A 被抢占后退出发言状态', !(await pa.$eval('.ptt', (e) => e.className.includes('active'))))
	ok('A 看到 B 正在说话', (await pa.$eval('.status-line', (e) => e.textContent || '')).includes('爸爸'))
	const remoteA = await maxLevel(pa, '.level.remote', 1200)
	ok('A 收到 B 的音频', remoteA > 0, `remote level=${remoteA}`)
	await pb.mouse.up()
	await sleep(300)

	// ---------- 重连 ----------
	console.log('\n\x1b[1m断线重连\x1b[0m')
	await pa.evaluate(() => {
		// 强制断开底层连接，模拟断网
		// @ts-ignore
		const ws = window.__ft_ws
		if (ws) ws.close()
	})
	await sleep(2500)
	const stillOnline = await pa.evaluate(() => {
		const el = document.querySelector('.conn')
		return el ? el.textContent : ''
	})
	ok('断网后自动重连成功', stillOnline.includes('已连接'), `状态=${stillOnline}`)

	await browser.close()
	console.log(`\n\x1b[1m结果: ${passed} 通过, ${failed} 失败\x1b[0m`)
	process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
	console.error('\nE2E 异常终止:', err)
	process.exit(1)
})
