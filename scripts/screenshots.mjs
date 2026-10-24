#!/usr/bin/env node
/**
 * 生成 README 用的界面截图（真实 Chrome，移动端视口）
 *
 *   node scripts/screenshots.mjs
 *
 * 输出到 docs/images/
 *
 * 注意：puppeteer 对非前台页面的 page.click() 会挂起，
 * 所以每次操作页面前都要 await page.bringToFront()。
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '..', 'docs', 'images')
const TARGET = process.env.SHOT_URL || 'http://127.0.0.1:8443'
const CODE = process.env.FAMILY_CODE || 'shot1234'
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome'

let puppeteer
try {
	puppeteer = (await import('puppeteer-core')).default
} catch {
	console.error('需要 puppeteer-core：npm i -D puppeteer-core')
	process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true }

/** 用原生 setter 填 React 受控输入框 */
async function fill(page, selector, value) {
	await page.evaluate(
		(sel, val) => {
			const el = document.querySelector(sel)
			if (!el) throw new Error('找不到 ' + sel)
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
			setter.call(el, val)
			el.dispatchEvent(new Event('input', { bubbles: true }))
		},
		selector,
		value,
	)
}

async function enter(page, name) {
	await page.bringToFront()
	await page.goto(TARGET, { waitUntil: 'domcontentloaded' })
	await page.waitForSelector('input[type="text"]', { timeout: 15000 })
	await page.evaluate(() => localStorage.removeItem('footalker.creds'))
	await fill(page, 'input[type="text"]', name)
	await fill(page, 'input[type="password"]', CODE)
	await page.waitForFunction(() => {
		const b = document.querySelector('.primary-btn')
		return b && !b.disabled
	})
	await page.click('.primary-btn')
	await page.waitForSelector('.ptt', { timeout: 15000 })
}

async function main() {
	mkdirSync(OUT, { recursive: true })

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
			'--force-color-profile=srgb',
			'--font-render-hinting=none',
		],
	})

	const ctx = browser.defaultBrowserContext()
	await ctx.overridePermissions(new URL(TARGET).origin, ['microphone'])

	// ---- 门禁页 ----
	const pGate = await browser.newPage()
	await pGate.setViewport(VIEWPORT)
	await pGate.bringToFront()
	await pGate.goto(TARGET, { waitUntil: 'domcontentloaded' })
	await pGate.waitForSelector('.gate-card')
	await sleep(400)
	await pGate.screenshot({ path: path.join(OUT, 'gate.png') })
	console.log('✓ docs/images/gate.png')
	await pGate.close()

	// ---- 房间页（两人，其中一人正在说话）----
	const p1 = await browser.newPage()
	await p1.setViewport(VIEWPORT)
	const p2 = await browser.newPage()
	await p2.setViewport(VIEWPORT)

	await enter(p2, '小明')
	console.log('小明已进房')

	await enter(p1, '妈妈')
	console.log('妈妈已进房')
	await sleep(600)

	// 妈妈按住说话，成员列表出现「说话中」高亮
	await p1.bringToFront()
	const box = await p1.$eval('.ptt', (el) => {
		const r = el.getBoundingClientRect()
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
	})
	await p1.mouse.move(box.x, box.y)
	await p1.mouse.down()
	await sleep(1200)
	await p1.screenshot({ path: path.join(OUT, 'room.png') })
	console.log('✓ docs/images/room.png')
	await p1.mouse.up()

	await sleep(400)
	await browser.close()
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
