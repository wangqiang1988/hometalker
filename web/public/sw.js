/* FooTalker service worker —— 离线可用 + 启动更快 */
const CACHE = 'footalker-v1'
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((c) => c.addAll(SHELL))
			.then(() => self.skipWaiting())
			.catch(() => self.skipWaiting()),
	)
})

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	)
})

self.addEventListener('fetch', (event) => {
	const req = event.request
	if (req.method !== 'GET') return
	const url = new URL(req.url)
	if (url.origin !== self.location.origin) return
	// 实时接口和 WebSocket 不走缓存
	if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return

	// 带 hash 的构建产物：缓存优先
	if (url.pathname.startsWith('/assets/')) {
		event.respondWith(
			caches.match(req).then(
				(hit) =>
					hit ||
					fetch(req).then((res) => {
						const copy = res.clone()
						caches.open(CACHE).then((c) => c.put(req, copy))
						return res
					}),
			),
		)
		return
	}

	// 页面导航：网络优先（保证能拿到新版本），失败时回退缓存
	if (req.mode === 'navigate') {
		event.respondWith(
			fetch(req)
				.then((res) => {
					const copy = res.clone()
					caches.open(CACHE).then((c) => c.put('/', copy))
					return res
				})
				.catch(() => caches.match('/').then((hit) => hit || Response.error())),
		)
		return
	}

	event.respondWith(
		caches.match(req).then(
			(hit) =>
				hit ||
				fetch(req).then((res) => {
					const copy = res.clone()
					caches.open(CACHE).then((c) => c.put(req, copy))
					return res
				}),
		),
	)
})
