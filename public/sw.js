/*
 * Plan 的 Service Worker：只缓存静态资源，不做离线写入，也不接管导航。
 * 导航必须交给浏览器：plan 未登录时会 302 到 chat 完成 SSO，
 * 由 SW 内部 fetch 跟随重定向会把 chat 登录页当成 plan 的壳缓存下来。
 */
const VERSION = 'plan-v2'
// 不预缓存 '/'：未登录时它会 302 到 chat 登录，cache.addAll 会失败；
// 导航也完全不拦截，交给浏览器处理 SSO 跳转，避免把登录页缓存成 plan 壳。
const SHELL = ['/manifest.webmanifest', '/icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // 接口一律走网络：缓存会让人误以为任务还在
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(req))
    return
  }

  // 导航请求不调用 respondWith：让浏览器的重定向链（plan → chat → plan）正常工作

  // 静态资源（Vite 产物带 hash）：缓存优先
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone()
            caches.open(VERSION).then((cache) => cache.put(req, copy))
          }
          return res
        })
    )
  )
})
