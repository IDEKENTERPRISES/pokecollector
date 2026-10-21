// After each splash: fetch the next launch's Pokémon and its sprite, so the next cold start is
// instant and works offline. The entry goes to localStorage (entryStore.js); the sprite goes to a
// small Cache Storage cache holding only the next sprite and the starter's, never all 1025.
import { STARTER } from './config'
import { isSplashEntry, readSeen, writeNextEntry } from './entryStore'

// Not "pc-…": resetServiceWorker() deletes those whenever the service worker is switched off.
export const SPRITE_CACHE = 'pokecollector-splash-v1'
const TIMEOUT_MS = 10000

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    return await fetchImpl(url, { ...options, signal: controller?.signal })
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function isImage(response) {
  return Boolean(response?.ok) && (response.headers.get('Content-Type') || '').toLowerCase().startsWith('image/')
}

function pathOf(url) {
  return new URL(url, globalThis.location?.origin || 'http://localhost').pathname
}

async function openCache(cacheStorage) {
  try {
    return cacheStorage ? await cacheStorage.open(SPRITE_CACHE) : null
  } catch {
    return null // no Cache Storage (plain http, some private modes): the HTTP cache still helps
  }
}

/** Puts a sprite in the splash cache unless it is there already. True when it is usable. */
async function cacheSprite(cache, url, fetchImpl, timeoutMs) {
  if (cache && await cache.match(url).catch(() => null)) return true
  const response = await fetchWithTimeout(fetchImpl, url, { credentials: 'same-origin' }, timeoutMs)
  if (!isImage(response)) return false
  if (cache) await cache.put(url, response.clone()).catch(() => {})
  return true
}

async function prune(cache, keep) {
  const wanted = new Set(keep.map(pathOf))
  for (const request of await cache.keys()) {
    if (!wanted.has(pathOf(request.url))) await cache.delete(request)
  }
}

/** Returns 'stored', 'failed' or 'skipped'. Never throws. */
export async function prefetchNextEntry({
  language = 'en',
  fetchImpl = globalThis.fetch?.bind(globalThis),
  cacheStorage = globalThis.caches,
  storage = globalThis.localStorage,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  if (!fetchImpl) return 'skipped'
  try {
    const params = new URLSearchParams({ lang: language })
    const seen = readSeen(storage)
    if (seen) params.set('seen', seen)
    const response = await fetchWithTimeout(
      fetchImpl, `/api/pokedex/splash?${params}`, { credentials: 'same-origin', cache: 'no-store' }, timeoutMs,
    )
    if (!response?.ok) return 'failed'
    const entry = await response.json()
    if (!isSplashEntry(entry)) return 'failed'
    const cache = await openCache(cacheStorage)
    // Store the entry only once its sprite is ready, so a stored entry always shows complete.
    if (!(await cacheSprite(cache, entry.sprite_url, fetchImpl, timeoutMs))) return 'failed'
    // The starter is the fallback whenever nothing is prefetched; keep its sprite too.
    await cacheSprite(cache, STARTER.sprite_url, fetchImpl, timeoutMs).catch(() => false)
    if (cache) await prune(cache, [entry.sprite_url, STARTER.sprite_url]).catch(() => {})
    return writeNextEntry({ ...entry, fetched_at: Date.now() }, storage) ? 'stored' : 'failed'
  } catch {
    return 'failed'
  }
}

/** A URL for the entry's sprite: a blob: URL from the splash cache when it has the file (so it
 * works offline), else the server URL. The caller revokes blob: URLs. */
export async function spriteSource(entry, { cacheStorage = globalThis.caches } = {}) {
  const url = entry?.sprite_url
  if (!url) return null
  try {
    const hit = cacheStorage ? await cacheStorage.match(url, { cacheName: SPRITE_CACHE }) : null
    if (isImage(hit)) return URL.createObjectURL(await hit.blob())
  } catch {
    // fall back to the network URL
  }
  return url
}
