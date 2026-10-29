/* PokéCollector service worker (docs/PWA_OFFLINE_DESIGN.md §6.3). Classic script, no imports.
   Caches only the app's own static files and public card images. It never caches API data. */
const BUILD_ID = '__BUILD_ID__'
const PRECACHE = /*__PRECACHE__*/ []

const PRECACHE_NAME = 'pc-precache-' + BUILD_ID
const SHELL_NAME = 'pc-shell-' + BUILD_ID
const IMAGES_NAME = 'pc-images-v1'
const SHELL_KEY = '/shell'
const IMAGE_CAP = 800
// Pictures downloaded on purpose from Settings (offline card database) live in IndexedDB, one Blob per
// set plus an index (offline/carddb/pictureStore.js: same names). Never in Cache Storage: thousands of
// entries there made WebKit's first Cache Storage access of every launch take seconds.
const PICTURE_DB = 'pokecollector-pictures'
const NAV_TIMEOUT_MS = 2500
// After a navigation had to fall back to the shell, the next ones wait only this long for a while.
const NAV_FAST_TIMEOUT_MS = 600
const NAV_RECENT_FAILURE_MS = 5 * 60 * 1000
// Tiny cache holding what the page last told the worker about reachability; the worker is stopped
// and restarted often, so the flag must survive a cold start (an offline launch).
const STATE_NAME = 'pc-sw-state-v1'
const STATE_KEY = '/__pc_sw_state'
const LARGE_IMAGE_TIMEOUT_MS = 4000
// A picture nobody has cached: offline on an iPhone the request hangs instead of failing, so give
// the network this long, then answer with an error and let the tile show its placeholder.
const IMAGE_NETWORK_TIMEOUT_MS = 3000
const IMAGE_PREFIXES = ['/api/images/card/', '/api/images/set/', '/api/pokedex/images/']

const OFFLINE_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>PokéCollector</title></head>'
  + '<body style="margin:0;padding:2rem;background:#000000;color:#fff;font-family:system-ui,sans-serif">'
  + '<p>You are offline and this page is not saved on this device yet. Reconnect and reload.</p>'
  + '<p>Du bist offline und diese Seite ist noch nicht auf diesem Gerät gespeichert. Verbinde dich und lade neu.</p>'
  + '</body></html>'

const precacheUrls = new Set(PRECACHE.map(entry => entry.url))

// Reachability as the page last reported it (OfflineProvider's banner): the shell and every image
// answer from it without waiting on the network.
let pageOffline = false
let stateLoaded = null
let navFailedAt = 0
let pictureDb = null

function loadState() {
  if (!stateLoaded) {
    stateLoaded = (async () => {
      try {
        if (!(await caches.has(STATE_NAME))) return
        const hit = await (await caches.open(STATE_NAME)).match(STATE_KEY)
        if (hit) pageOffline = Boolean((await hit.json()).offline)
      } catch {
        // No saved state: treat as unknown (online).
      }
    })()
  }
  return stateLoaded
}

async function saveState(offline) {
  pageOffline = offline
  stateLoaded = stateLoaded || Promise.resolve()
  try {
    const cache = await caches.open(STATE_NAME)
    await cache.put(STATE_KEY, new Response(JSON.stringify({ offline }), { headers: { 'Content-Type': 'application/json' } }))
  } catch {
    // Not persisted: the in-memory flag still works for this worker's lifetime.
  }
}

function deviceOffline() {
  return Boolean(self.navigator) && self.navigator.onLine === false
}

async function knownOffline() {
  await loadState()
  return pageOffline || deviceOffline()
}

// The picture database, opened once per worker run. Null when it does not exist (nothing downloaded):
// the open is cancelled from its upgrade so the worker never creates an empty database for the page.
function openPictureDb() {
  if (!pictureDb) {
    pictureDb = new Promise(resolve => {
      try {
        const request = indexedDB.open(PICTURE_DB)
        request.onupgradeneeded = () => request.transaction.abort()
        request.onsuccess = () => {
          const db = request.result
          db.onversionchange = () => { db.close(); pictureDb = null }
          resolve(db)
        }
        request.onerror = event => { event.preventDefault(); resolve(null) }
        request.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    }).then(db => {
      if (!db) pictureDb = null // look again next time (a download may have created it since)
      return db
    })
  }
  return pictureDb
}

function idbGet(db, storeName, key) {
  return new Promise(resolve => {
    try {
      const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function hasExtension(pathname) {
  const last = pathname.split('/').pop() || ''
  return last.includes('.')
}

// Returns 'none' | 'precache' | 'navigate' | 'image'.
function classify(req, url) {
  if (req.method !== 'GET') return 'none'
  if (url.origin !== self.location.origin) return 'none'
  if (req.headers.has('Range') || req.headers.has('Authorization')) return 'none'
  if (url.pathname === '/sw.js' || /^\/sw\.[a-z]+\.js$/.test(url.pathname)) return 'none'
  if (url.searchParams.has('pc_sw')) return 'none'
  if (precacheUrls.has(url.pathname)) return 'precache'
  if (req.mode === 'navigate' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/assets/')
    && !hasExtension(url.pathname)) return 'navigate'
  if (IMAGE_PREFIXES.some(prefix => url.pathname.startsWith(prefix))) return 'image'
  return 'none'
}

function extensionOf(url) {
  const match = /\.([a-z0-9]+)$/i.exec(url.split('?')[0])
  return match ? match[1].toLowerCase() : ''
}

function validatePrecache(entry, res) {
  if (!res || !res.ok || res.status !== 200) return false
  if (res.type !== 'basic' || res.redirected) return false
  const type = (res.headers.get('Content-Type') || '').toLowerCase()
  const ext = extensionOf(entry.url)
  if (ext === 'js' || ext === 'mjs') return type.includes('javascript')
  if (ext === 'css') return type.includes('text/css')
  return !type.includes('text/html')
}

function validateShell(res, text, precacheSet) {
  if (!res || res.status !== 200 || res.redirected || res.type !== 'basic') return false
  if (!(res.headers.get('Content-Type') || '').includes('text/html')) return false
  if (!text.includes('id="root"')) return false
  for (const match of text.matchAll(/(?:src|href)="(\/assets\/[^"#?]+)"/g)) {
    if (!precacheSet.has(match[1])) return false
  }
  return true
}

function isCacheableImage(res) {
  if (!res || res.status !== 200 || res.type !== 'basic' || res.redirected) return false
  if (!(res.headers.get('Content-Type') || '').toLowerCase().startsWith('image/')) return false
  const cacheControl = (res.headers.get('Cache-Control') || '').toLowerCase()
  if (cacheControl.includes('no-store') || cacheControl.includes('private')) return false
  if ((res.headers.get('Vary') || '').toLowerCase().includes('authorization')) return false
  return true
}

async function trimCache(cache, max) {
  const keys = await cache.keys()
  for (let i = 0; i < keys.length - max; i += 1) await cache.delete(keys[i])
}

// A file from an older build's precache (each cache searched by name, never the picture caches).
async function matchOlderPrecache(url) {
  for (const name of (await caches.keys()).reverse()) {
    if (!name.startsWith('pc-precache-') || name === PRECACHE_NAME) continue
    const hit = await caches.match(url, { cacheName: name })
    if (hit) return hit
  }
  return null
}

async function precacheOne(cache, entry) {
  if (entry.url.startsWith('/assets/')) {
    const old = await matchOlderPrecache(entry.url)
    if (old && validatePrecache(entry, old)) {
      await cache.put(entry.url, old.clone())
      return
    }
  }
  const res = await fetch(entry.url, { cache: 'reload', credentials: 'same-origin' })
  if (!validatePrecache(entry, res)) throw new Error('precache validation failed: ' + entry.url)
  await cache.put(entry.url, res)
}

async function precacheAll() {
  const cache = await caches.open(PRECACHE_NAME)
  const queue = PRECACHE.slice()
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) await precacheOne(cache, entry)
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  const res = await fetch('/', { cache: 'reload', credentials: 'same-origin' })
  const text = await res.clone().text()
  if (!validateShell(res, text, precacheUrls)) throw new Error('shell validation failed')
  await (await caches.open(SHELL_NAME)).put(SHELL_KEY, res)
}

async function maybeStoreShell(res) {
  // Only refresh an existing shell: after the kill worker deleted the caches, a late
  // navigation handled by this (unregistered) worker must not recreate them.
  if (!(await caches.has(SHELL_NAME))) return
  const text = await res.clone().text()
  if (validateShell(res, text, precacheUrls)) {
    await (await caches.open(SHELL_NAME)).put(SHELL_KEY, res)
  }
}

async function offlineShell() {
  const shell = await caches.match(SHELL_KEY, { cacheName: SHELL_NAME })
  return shell || new Response(OFFLINE_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

function handleNavigate(event) {
  event.respondWith((async () => {
    if (await knownOffline()) {
      // The app knows it is offline: the shell at once, with a quiet refresh attempt for later.
      event.waitUntil(fetch(event.request).then(res => (res.ok ? maybeStoreShell(res.clone()) : null)).catch(() => {}))
      return offlineShell()
    }
    const network = fetch(event.request)
    const recentFailure = Date.now() - navFailedAt < NAV_RECENT_FAILURE_MS
    const timer = new Promise(resolve => setTimeout(() => resolve(null), recentFailure ? NAV_FAST_TIMEOUT_MS : NAV_TIMEOUT_MS))
    try {
      const res = await Promise.race([network, timer])
      if (res) {
        navFailedAt = 0
        if (res.ok) event.waitUntil(maybeStoreShell(res.clone()).catch(() => {}))
        return res
      }
      // Timer won: keep the network request alive so the shell can refresh later.
      navFailedAt = Date.now()
      event.waitUntil(network.then(late => (late.ok ? maybeStoreShell(late.clone()) : null)).catch(() => {}))
    } catch {
      navFailedAt = Date.now()
    }
    return offlineShell()
  })())
}

// '/api/images/card/{id}/large' -> '/api/images/card/{id}/small', or null for any other path.
function smallImagePath(pathname) {
  const match = /^(\/api\/images\/card\/.+)\/large$/.exec(pathname)
  return match ? match[1] + '/small' : null
}

async function storeImage(cache, request, res) {
  if (!isCacheableImage(res)) return
  await cache.put(request, res.clone())
  await trimCache(cache, IMAGE_CAP)
}

// Offline (or on a hung connection) the detail view's large image falls back to the small copy
// the collection grid already cached. A late network answer is still stored for the next view.
async function fetchLargeImage(event, cache, smallPath, offline) {
  const smallCopy = async () => {
    const url = new URL(smallPath, self.location.origin).href
    return (await cache.match(url, { ignoreSearch: true })) || matchDownloadedPicture(new Request(url))
  }
  if (offline) return (await smallCopy()) || Response.error()
  const network = fetch(event.request)
  const store = res => storeImage(cache, event.request, res).catch(() => {})
  const timer = new Promise(resolve => setTimeout(() => resolve(null), LARGE_IMAGE_TIMEOUT_MS))
  let res
  try {
    res = await Promise.race([network, timer])
  } catch {
    return (await smallCopy()) || Response.error()
  }
  if (res) {
    event.waitUntil(store(res))
    return res
  }
  const small = await smallCopy()
  // No small copy to fall back on: fail now (the tile shows its placeholder) rather than hang
  // on the connection; a late answer is still stored for the next view.
  event.waitUntil(network.then(store, () => {}))
  return small || Response.error()
}

// A pack is a Blob, or an ArrayBuffer where the browser cannot keep Blobs in IndexedDB.
const sliceOf = (value, start, end, type) => (typeof value.size === 'number'
  ? value.slice(start, end, type)
  : new Blob([value.slice(start, end)], { type }))

// Packs kept as ArrayBuffers (no Blobs in IndexedDB) are read whole: keep the last few, so a set's
// pictures cost one read. Blob packs are sliced without reading and need no cache.
const PACK_CACHE_MAX = 3
const packCache = new Map()
async function packOf(db, key) {
  if (packCache.has(key)) {
    const hit = packCache.get(key)
    packCache.delete(key)
    packCache.set(key, hit)
    return hit
  }
  const pack = await idbGet(db, 'packs', key)
  if (pack && typeof pack.size !== 'number') {
    packCache.set(key, pack)
    if (packCache.size > PACK_CACHE_MAX) packCache.delete(packCache.keys().next().value)
  }
  return pack
}

const pictureResponse = (blob, type) => new Response(blob, {
  headers: { 'Content-Type': type || blob.type || 'image/webp', 'Cache-Control': 'public, max-age=86400' },
})

// A card's downloaded small picture (a slice of its set's pack) or a loose downloaded picture (set
// logo or symbol, a card the pack did not carry) from the picture database; null when there is none.
// Large requests are answered from the small picture by the caller.
async function matchDownloadedPicture(request) {
  const { pathname } = new URL(request.url)
  const card = /^\/api\/images\/card\/(.+)\/small$/.exec(pathname)
  const db = await openPictureDb()
  if (!db) return null
  try {
    if (card) {
      const entry = await idbGet(db, 'index', decodeURIComponent(card[1]))
      if (entry) {
        const pack = await packOf(db, entry.p)
        if (pack) return pictureResponse(sliceOf(pack, entry.o, entry.o + entry.l, entry.t), entry.t)
      }
    }
    const loose = await idbGet(db, 'loose', pathname)
    return loose ? pictureResponse(sliceOf(loose.blob, 0, loose.blob.size ?? loose.blob.byteLength, loose.t), loose.t) : null
  } catch {
    return null
  }
}

function handleImage(event) {
  event.respondWith((async () => {
    const cache = await caches.open(IMAGES_NAME)
    const hit = await cache.match(event.request)
    if (hit) return hit
    const downloaded = await matchDownloadedPicture(event.request)
    if (downloaded) return downloaded
    const offline = await knownOffline()
    const smallPath = smallImagePath(new URL(event.request.url).pathname)
    if (smallPath) return fetchLargeImage(event, cache, smallPath, offline)
    // Known offline and nothing cached: fail at once so the tile shows its placeholder.
    if (offline) return Response.error()
    const network = fetch(event.request)
    const store = res => storeImage(cache, event.request, res).catch(() => {})
    const timer = new Promise(resolve => setTimeout(() => resolve(null), IMAGE_NETWORK_TIMEOUT_MS))
    const res = await Promise.race([network, timer])
    if (!res) {
      // Hung connection: fail fast, but keep the request alive so a late answer is still stored.
      event.waitUntil(network.then(store, () => {}))
      return Response.error()
    }
    event.waitUntil(store(res))
    return res
  })())
}

self.addEventListener('install', event => {
  event.waitUntil(precacheAll())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      const stale = (name.startsWith('pc-precache-') && name !== PRECACHE_NAME)
        || (name.startsWith('pc-shell-') && name !== SHELL_NAME)
      if (stale) await caches.delete(name)
    }
  })())
})

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  const kind = classify(event.request, url)
  if (kind === 'precache') {
    event.respondWith(caches.match(url.pathname, { cacheName: PRECACHE_NAME })
      .then(hit => hit || fetch(event.request)))
  } else if (kind === 'navigate') {
    handleNavigate(event)
  } else if (kind === 'image') {
    handleImage(event)
  }
})

self.addEventListener('message', event => {
  const data = event.data || {}
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  } else if (data.type === 'REACHABILITY') {
    event.waitUntil(saveState(Boolean(data.offline)))
  } else if (data.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'VERSION', buildId: BUILD_ID, appVersion: self.__PC_APP_VERSION__ || null })
  }
})

// Web push (docs/PWA_OFFLINE_DESIGN.md §6.7). Always shows a notification: Apple revokes the
// subscription of sites that receive pushes without showing one. The payload is Declarative
// Web Push JSON ({web_push, notification:{title, body, navigate}}); only a string title and
// body are used, anything else falls back to a generic notification.
const DEFAULT_NOTIFICATION_TITLE = 'PokéCollector'

// Icon number: only actionable pushes carry one (`app_badge`, a whole number; 0 clears it).
function badgeCount(data) {
  const n = data && typeof data === 'object' ? data.app_badge : null
  return Number.isInteger(n) && n >= 0 && n <= 99999 ? n : null
}

async function applyBadge(count) {
  const nav = self.navigator
  try {
    if (count === null || !nav) return
    if (count === 0 && typeof nav.clearAppBadge === 'function') await nav.clearAppBadge()
    else if (count > 0 && typeof nav.setAppBadge === 'function') await nav.setAppBadge(count)
  } catch {
    // No badge support or no permission: the notification still shows.
  }
}

function pushPayload(event) {
  try {
    const data = event.data ? event.data.json() : null
    const note = data && typeof data === 'object' ? (data.notification || data) : null
    if (note && typeof note.title === 'string' && note.title) {
      return {
        title: note.title.slice(0, 120),
        body: typeof note.body === 'string' ? note.body.slice(0, 300) : '',
        navigate: typeof note.navigate === 'string' ? note.navigate : '',
        badge: badgeCount(data),
      }
    }
  } catch {
    // Not JSON: fall through to the generic notification.
  }
  return { title: DEFAULT_NOTIFICATION_TITLE, body: '', navigate: '', badge: null }
}

// Same-origin target only; anything else opens the app root.
function safeNavigateUrl(navigate) {
  try {
    const url = new URL(navigate || '/', self.location.origin)
    return url.origin === self.location.origin ? url.href : new URL('/', self.location.origin).href
  } catch {
    return new URL('/', self.location.origin).href
  }
}

async function focusOrOpen(target) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const open = windows.find(client => new URL(client.url).origin === self.location.origin)
  if (open) {
    try {
      await open.focus()
      if (typeof open.navigate === 'function') await open.navigate(target)
      return
    } catch {
      // Fall through and open a new window.
    }
  }
  await self.clients.openWindow(target)
}

self.addEventListener('push', event => {
  const { title, body, navigate, badge } = pushPayload(event)
  const options = { body, data: { navigate: navigate || '/' } }
  event.waitUntil(Promise.all([self.registration.showNotification(title, options), applyBadge(badge)]))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil(focusOrOpen(safeNavigateUrl(event.notification.data && event.notification.data.navigate)))
})

if (self.__PC_SW_TEST_MODE__) {
  self.__PC_SW_TEST__ = { pushPayload, safeNavigateUrl, classify, validatePrecache, validateShell, isCacheableImage, trimCache, smallImagePath }
}
