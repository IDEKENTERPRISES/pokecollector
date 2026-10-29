// Fetching the Pokémon of the day ahead, so the first launch of a day is instant and works
// offline. Entries go to localStorage (entryStore.js); sprites go to a small Cache Storage cache
// holding only today's, tomorrow's and the starter's, never all 1025.
import { STARTER } from './config'
import { isSplashEntry, localDate, readDay, writeDay } from './entryStore'
import { fetchPuzzle, readPuzzle, writePuzzle } from './wtp'

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

const defaults = () => ({
  fetchImpl: globalThis.fetch?.bind(globalThis),
  cacheStorage: globalThis.caches,
  storage: globalThis.localStorage,
  timeoutMs: TIMEOUT_MS,
})

/** The server's entry for a date, or null. Never throws. */
export async function fetchDay(date, { language = 'en', fetchImpl = defaults().fetchImpl, timeoutMs = TIMEOUT_MS } = {}) {
  if (!fetchImpl) return null
  try {
    const params = new URLSearchParams({ date, lang: language })
    const response = await fetchWithTimeout(
      fetchImpl, `/api/pokedex/splash?${params}`, { credentials: 'same-origin', cache: 'no-store' }, timeoutMs,
    )
    if (!response?.ok) return null
    const entry = await response.json()
    return isSplashEntry(entry) && entry.date === date ? entry : null
  } catch {
    return null
  }
}

/** Puts a sprite in the splash cache unless it is there already. True when it is usable. */
export async function cacheSprite(url, { fetchImpl = defaults().fetchImpl, cacheStorage = defaults().cacheStorage, timeoutMs = TIMEOUT_MS } = {}) {
  try {
    const cache = await openCache(cacheStorage)
    if (cache && await cache.match(url).catch(() => null)) return true
    const response = await fetchWithTimeout(fetchImpl, url, { credentials: 'same-origin' }, timeoutMs)
    if (!isImage(response)) return false
    if (cache) await cache.put(url, response.clone()).catch(() => {})
    return true
  } catch {
    return false
  }
}

/** A URL for the entry's sprite: a blob: URL from the splash cache when it has the file (so it
 * works offline), else the server URL. The caller revokes blob: URLs. */
export async function spriteSource(entry, { cacheStorage = defaults().cacheStorage } = {}) {
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

/** Today's (or any day's) entry with its sprite cached: from the device, else from the server. */
export async function ensureDay(date, options = {}) {
  const { language = 'en', storage = defaults().storage } = options
  const stored = readDay(date, storage)
  if (stored && stored.lang === language) return stored
  const entry = await fetchDay(date, options)
  if (!entry) return stored
  if (!(await cacheSprite(entry.sprite_url, options))) return stored
  writeDay(entry, storage, localDate(0, options.now))
  return entry
}

/** A day's Who's That Pokémon puzzle with its image cached: from the device, else the server. */
export async function ensurePuzzle(date, options = {}) {
  const { language = 'en', storage = defaults().storage } = options
  const stored = readPuzzle(date, language, storage)
  if (stored) return stored
  const puzzle = await fetchPuzzle(date, options)
  if (!puzzle) return null
  if (!(await cacheSprite(puzzle.sprite_url, options))) return null
  writePuzzle(puzzle, storage, localDate(0, options.now))
  return puzzle
}

/** After a splash: today's and tomorrow's entries and sprites, then drop every other sprite.
 * Returns 'stored', 'failed' or 'skipped'. Never throws. */
export async function prefetchDays(options = {}) {
  const settings = { ...defaults(), ...options }
  if (!settings.fetchImpl) return 'skipped'
  const today = localDate(0, settings.now)
  const tomorrow = localDate(1, settings.now)
  const entries = []
  for (const date of [today, tomorrow]) entries.push(await ensureDay(date, settings))
  // Who's That Pokémon rides along, so tomorrow's puzzle is playable offline too.
  const puzzles = []
  for (const date of [today, tomorrow]) puzzles.push(await ensurePuzzle(date, settings))
  // The starter is the fallback whenever nothing is stored; keep its sprite too.
  await cacheSprite(STARTER.sprite_url, settings)
  const cache = await openCache(settings.cacheStorage)
  if (cache) {
    const keep = new Set([STARTER.sprite_url, ...entries.filter(Boolean).map(entry => entry.sprite_url), ...puzzles.filter(Boolean).map(puzzle => puzzle.sprite_url)].map(pathOf))
    try {
      for (const request of await cache.keys()) {
        if (!keep.has(pathOf(request.url))) await cache.delete(request)
      }
    } catch {
      // a stale sprite costs a little storage, nothing more
    }
  }
  return entries[1]?.date === tomorrow ? 'stored' : 'failed'
}
