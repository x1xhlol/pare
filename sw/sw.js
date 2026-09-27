// Pare's service worker. It makes the app work offline and installable, and receives videos shared to it.
//
// The page and its scripts are cached when this installs; the encoders (several MB) once a video is opened, since a
// visitor who never opens one doesn't need them. Pages come from the network when there is one, so a new version
// shows up at once; the hashed assets never change, so they come from the cache. The build fills in the lists
// (vite.config.ts, serviceWorker).
const VERSION = __VERSION__
const SHELL = __SHELL__
const ASSETS = __ASSETS__
const CACHE = `pare-${VERSION}`
/** A video shared to Pare (the manifest's share_target), held for the page to pick up. */
const SHARED = 'pare-shared'

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/', ...SHELL])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE && key !== SHARED) await caches.delete(key)
    await self.clients.claim()
  })())
})

self.addEventListener('message', (event) => {
  if (event.data !== 'warm') return
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    for (const url of ASSETS) if (!(await cache.match(url))) await cache.add(url).catch(() => {})
  })())
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (request.method === 'POST' && url.pathname === '/share') return event.respondWith(receive(request))
  if (request.method !== 'GET') return
  if (request.mode === 'navigate') return event.respondWith(page(request))
  if (url.pathname.startsWith('/assets/') || SHELL.includes(url.pathname)) event.respondWith(asset(request))
})

async function page(request) {
  try {
    const response = await fetch(request)
    if (response.ok && new URL(request.url).pathname === '/')
      await (await caches.open(CACHE)).put('/', response.clone())
    return response
  } catch (err) {
    const cached = await caches.match('/', { ignoreVary: true })
    if (cached) return cached
    throw err
  }
}

async function asset(request) {
  // Module scripts and fonts are requested with an Origin header that cache.addAll's requests lack; a server answering
  // with Vary: Origin would make every one miss. These files never change under their names.
  const cached = await caches.match(request, { ignoreVary: true })
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) await (await caches.open(CACHE)).put(request, response.clone())
  return response
}

async function receive(request) {
  const data = await request.formData()
  const file = data.get('video')
  if (file instanceof File) {
    const headers = { 'content-type': file.type || 'application/octet-stream', 'x-name': encodeURIComponent(file.name) }
    await (await caches.open(SHARED)).put('/shared', new Response(file, { headers }))
  }
  return Response.redirect('/?shared', 303)
}
