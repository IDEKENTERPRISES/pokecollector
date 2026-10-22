// Read cache of previously viewed data (docs/PWA_OFFLINE_DESIGN.md §9.2 P8, D1, D8, D10).
// Successful TanStack queries of every page are saved (owner feedback F12: every page opens offline),
// except a deny list of anything sensitive or useless offline. They are saved per user and origin in their own IndexedDB
// database (never the outbox's) and put back when the app starts degraded. Every IndexedDB access
// is guarded: a failure means the feature is off, never a crash.

import { dehydrate, hydrate } from '@tanstack/react-query'

const KIB = 1024
const MIB = 1024 * KIB
const DAY_MS = 24 * 60 * 60 * 1000

export const READ_CACHE_DB_NAME = 'pokecollector-readcache'
export const READ_CACHE_DB_VERSION = 1
export const READ_CACHE_STORE = 'qc'
export const READ_CACHE_RECORD_VERSION = 1
export const READ_CACHE_MAX_QUERY_BYTES = 15 * MIB
export const READ_CACHE_MAX_TOTAL_BYTES = 50 * MIB
export const READ_CACHE_MAX_AGE_MS = 30 * DAY_MS
export const READ_CACHE_THROTTLE_MS = 5000

/**
 * Queries that are never saved, by the first element of their key: anything holding a link, token or
 * key, administration data, and data that is useless offline because it only describes the server's
 * live state. Everything else is saved when it succeeds. To keep a new query out, add its key here.
 */
export const READ_CACHE_DENY = new Set([
  'invites', // invite links and who used them
  'audit-log', // the audit log
  'users', // the admin user list
  'user-sessions',
  'sessions', // signed-in devices
  'scanner-configuration', // provider setup (keys are masked server-side, but it is admin configuration)
  'push', // push subscriptions
  'push-subscription',
  'telegram-status', // bot tokens and chat ids
  'setting', // single admin settings, some of them secrets
  'sync-status', // live sync progress
  'scan-jobs', // the live scan inbox
  'scan-job',
  'collection-photo', // blobs, not JSON
  'carddb', // answers read from the offline card database (F13b), never saved as if the server sent them
])

// A key part that names a secret keeps the query out whatever its first element is.
const SENSITIVE_KEY_PART = /token|secret|password|passwd|api[-_]?key|credential|authorization|invite|session/i
// A field of that kind anywhere in the data keeps the query out too (checked while measuring it).
const SENSITIVE_FIELD = /"[A-Za-z_]*(?:token|secret|password|passwd|api_?key|credential)[A-Za-z_]*"\s*:/i

/** Whether a query with this key may be saved in the read cache. */
export function isSavableKey(queryKey) {
  const first = queryKey?.[0]
  if (typeof first !== 'string' || first === '') return false
  if (READ_CACHE_DENY.has(first)) return false
  return !queryKey.some(part => typeof part === 'string' && SENSITIVE_KEY_PART.test(part))
}

function currentAppVersion() {
  // eslint-disable-next-line no-undef
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
}

export const recordKey = (origin, userId) => `${origin}|${userId}`

const isAllowed = query => query.state.status === 'success' && isSavableKey(query.queryKey)

/** True when the data holds a field named like a secret (a token, password or API key). */
export function holdsSecret(json) {
  return typeof json === 'string' && SENSITIVE_FIELD.test(json)
}

function sizeOf(data) {
  try {
    const json = JSON.stringify(data)
    if (holdsSecret(json)) return Infinity // dropped by applyCaps like an oversized query
    return json?.length ?? 0
  } catch {
    return Infinity
  }
}

function openDb(indexedDB = globalThis.indexedDB) {
  return new Promise((resolve, reject) => {
    if (!indexedDB) {
      reject(new Error('IndexedDB is not available'))
      return
    }
    let request
    try {
      request = indexedDB.open(READ_CACHE_DB_NAME, READ_CACHE_DB_VERSION)
    } catch (error) {
      reject(error)
      return
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(READ_CACHE_STORE)) request.result.createObjectStore(READ_CACHE_STORE)
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => db.close()
      resolve(db)
    }
    request.onerror = event => {
      event?.preventDefault?.()
      reject(request.error)
    }
  })
}

const promisify = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const txDone = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'))
  tx.onerror = () => reject(tx.error)
})

// Runs `work(store, tx)` in one transaction; resolves its result, or `fallback` on any failure.
async function withStore(indexedDB, mode, work, fallback) {
  let db = null
  try {
    db = await openDb(indexedDB)
    const tx = db.transaction(READ_CACHE_STORE, mode)
    const done = txDone(tx)
    done.catch(() => {}) // a failure surfaces through `await done` below, or is the fallback's job
    const result = await work(tx.objectStore(READ_CACHE_STORE), tx)
    if (mode === 'readwrite') await done
    return result
  } catch {
    return fallback
  } finally {
    try {
      db?.close()
    } catch {
      // already closed
    }
  }
}

const readRecord = (indexedDB, key) => withStore(indexedDB, 'readonly', store => promisify(store.get(key)), null)

/**
 * Applies the per-query and total caps to a list of dehydrated queries (oldest `dataUpdatedAt`
 * is dropped first until the total fits).
 */
export function applyCaps(queries) {
  const sized = queries
    .map(query => ({ query, bytes: sizeOf(query.state?.data) }))
    .filter(entry => entry.bytes <= READ_CACHE_MAX_QUERY_BYTES)
  let total = sized.reduce((sum, entry) => sum + entry.bytes, 0)
  if (total > READ_CACHE_MAX_TOTAL_BYTES) {
    sized.sort((a, b) => (b.query.state.dataUpdatedAt || 0) - (a.query.state.dataUpdatedAt || 0))
    while (total > READ_CACHE_MAX_TOTAL_BYTES && sized.length > 0) total -= sized.pop().bytes
  }
  return sized.map(entry => entry.query)
}

function isUsable(record, now) {
  return Boolean(record)
    && record.v === READ_CACHE_RECORD_VERSION
    && typeof record.savedAt === 'number'
    && record.appVersion === currentAppVersion()
    && now - record.savedAt <= READ_CACHE_MAX_AGE_MS
    && Array.isArray(record.state?.queries)
}

/** Builds the record to store: this session's allow-listed queries merged over the saved ones. */
export function buildRecord(queryClient, previous, { now = Date.now() } = {}) {
  const fresh = dehydrate(queryClient, { shouldDehydrateQuery: isAllowed })
  const byHash = new Map()
  // Pages not opened this session keep their saved data, until they are 30 days old.
  if (isUsable(previous, now)) {
    for (const query of previous.state.queries) {
      // A record written before a key went on the deny list loses that query on the next write.
      if (query?.state && isSavableKey(query.queryKey) && now - (query.state.dataUpdatedAt || 0) <= READ_CACHE_MAX_AGE_MS) byHash.set(query.queryHash, query)
    }
  }
  // This session's results replace the saved ones, except that an older copy (data put back by a
  // mid-session restore, or fetched before another tab saved a newer record) never overwrites a newer one.
  for (const query of fresh.queries) {
    const saved = byHash.get(query.queryHash)
    if (!saved || (query.state.dataUpdatedAt || 0) >= (saved.state?.dataUpdatedAt || 0)) byHash.set(query.queryHash, query)
  }
  return {
    v: READ_CACHE_RECORD_VERSION,
    savedAt: now,
    appVersion: currentAppVersion(),
    state: { mutations: [], queries: applyCaps([...byHash.values()]) },
  }
}

/**
 * Saves the allow-listed query results of `queryClient` for `{origin, userId}`, through a 5 s
 * trailing throttle driven by successful fetches. → `{flush, stop}`; `stop()` cancels a pending
 * write, forbids new ones and resolves once a write already started has finished.
 */
export function persist(queryClient, { origin, userId, indexedDB = globalThis.indexedDB, throttleMs = READ_CACHE_THROTTLE_MS } = {}) {
  const key = recordKey(origin, userId)
  let timer = null
  let stopped = false
  let inFlight = Promise.resolve()

  const write = () => {
    timer = null
    if (stopped) return inFlight
    inFlight = inFlight.then(() => withStore(indexedDB, 'readwrite', async store => {
      if (stopped) return false
      const previous = await promisify(store.get(key))
      store.put(buildRecord(queryClient, previous), key)
      return true
    }, false))
    return inFlight
  }

  const unsubscribe = queryClient.getQueryCache().subscribe(event => {
    if (stopped || event.type !== 'updated' || event.action?.type !== 'success') return
    if (!isSavableKey(event.query.queryKey)) return
    if (timer === null) timer = setTimeout(write, throttleMs)
  })

  return {
    flush: () => {
      if (timer !== null) clearTimeout(timer)
      return write()
    },
    stop: () => {
      stopped = true
      unsubscribe()
      if (timer !== null) clearTimeout(timer)
      timer = null
      return inFlight
    },
  }
}

/** Puts the saved queries of `{origin, userId}` back; → `savedAt` (ms) or `null`. */
export async function restore(queryClient, { origin, userId, indexedDB = globalThis.indexedDB, now = Date.now() } = {}) {
  try {
    const record = await readRecord(indexedDB, recordKey(origin, userId))
    if (!isUsable(record, now)) return null
    // Never bring back a query that is on the deny list now, whatever an older record still holds.
    hydrate(queryClient, { ...record.state, queries: record.state.queries.filter(query => isSavableKey(query?.queryKey)) })
    return record.savedAt
  } catch {
    return null
  }
}

/**
 * Mid-session restore (the app went offline while open): puts back the saved queries this session
 * does not hold yet. Merge only: a query that already has data keeps it, whatever the record says.
 * → `{ savedAt, restored }` (`savedAt` null when there is no usable record, `restored` the number of queries).
 */
export async function restoreMissing(queryClient, { origin, userId, indexedDB = globalThis.indexedDB, now = Date.now() } = {}) {
  try {
    const record = await readRecord(indexedDB, recordKey(origin, userId))
    if (!isUsable(record, now)) return { savedAt: null, restored: 0 }
    const cache = queryClient.getQueryCache()
    const missing = record.state.queries.filter(query => {
      if (!isSavableKey(query?.queryKey)) return false
      const held = cache.get(query.queryHash)
      return held?.state.data === undefined
    })
    if (missing.length > 0) hydrate(queryClient, { mutations: [], queries: missing })
    return { savedAt: record.savedAt, restored: missing.length }
  } catch {
    return { savedAt: null, restored: 0 }
  }
}

export async function purge({ origin, userId, indexedDB = globalThis.indexedDB } = {}) {
  return withStore(indexedDB, 'readwrite', store => { store.delete(recordKey(origin, userId)) }, undefined)
}

/** Deletes every record except the one of `keepUserId`. */
export async function purgeOthers({ origin, keepUserId, indexedDB = globalThis.indexedDB } = {}) {
  const keep = recordKey(origin, keepUserId)
  return withStore(indexedDB, 'readwrite', async store => {
    const keys = await promisify(store.getAllKeys())
    for (const key of keys) if (key !== keep) store.delete(key)
  }, undefined)
}

export async function purgeAll({ indexedDB = globalThis.indexedDB } = {}) {
  return withStore(indexedDB, 'readwrite', store => { store.clear() }, undefined)
}
