// What this device keeps for PokéCollector, split by kind (F17). Every figure is read lazily, when the
// Sync & offline page or the sync sheet is opened; nothing here runs on the launch path. A figure that
// cannot be read is `null`, never 0, so the page can say "not available".
import { PICTURE_DB_NAME, PICTURE_STORES } from './carddb/pictureStore.js'
import { READ_CACHE_DB_NAME, READ_CACHE_STORE } from './readCache.js'

const KIB = 1024
const MIB = KIB * 1024
const GIB = MIB * 1024

/** "12.0 KB", "110.9 MB", "38.4 GB": one decimal and a space. `null` when the figure is unknown. */
export function formatSize(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes)) || Number(bytes) < 0) return null
  const value = Number(bytes)
  if (value < MIB) return `${(value / KIB).toFixed(1)} KB`
  if (value < GIB) return `${(value / MIB).toFixed(1)} MB`
  return `${(value / GIB).toFixed(1)} GB`
}

/** Compressed card-database bytes: the sum over the languages that have data. `null` without a card database. */
export function cardDataBytes(languages) {
  if (!languages) return null
  return Object.values(languages).reduce((sum, info) => (info?.meta ? sum + (Number(info.bytes) || 0) : sum), 0)
}

const sizeOfBlob = value => {
  if (!value) return 0
  if (typeof value.size === 'number') return value.size
  if (typeof value.byteLength === 'number') return value.byteLength
  return 0
}

// Opens an existing database read-only. A database that does not exist yet holds nothing: the upgrade is
// cancelled so that looking never creates it, and `null` is returned for "no such database".
function openExisting(indexedDB, name) {
  return new Promise((resolve, reject) => {
    if (!indexedDB) {
      reject(new Error('IndexedDB is not available'))
      return
    }
    let missing = false
    const request = indexedDB.open(name)
    request.onupgradeneeded = () => {
      missing = true
      request.transaction.abort()
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => (missing ? resolve(null) : reject(request.error))
    request.onblocked = () => reject(new Error('blocked'))
  })
}

// Walks every record of a store and adds up `measure(value)`.
function sumStore(db, storeName, measure) {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(storeName)) {
      resolve(0)
      return
    }
    const request = db.transaction(storeName, 'readonly').objectStore(storeName).openCursor()
    let total = 0
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve(total)
        return
      }
      total += measure(cursor.value)
      cursor.continue()
    }
    request.onerror = () => reject(request.error)
  })
}

async function sumDatabase(indexedDB, name, stores) {
  const db = await openExisting(indexedDB, name)
  if (!db) return 0
  try {
    const totals = await Promise.all(stores.map(([store, measure]) => sumStore(db, store, measure)))
    return totals.reduce((sum, value) => sum + value, 0)
  } finally {
    db.close()
  }
}

/** Downloaded card pictures: the packs plus the loose pictures of `pokecollector-pictures`. `null` if unreadable. */
export function pictureBytes({ indexedDB = globalThis.indexedDB } = {}) {
  return sumDatabase(indexedDB, PICTURE_DB_NAME, [
    [PICTURE_STORES.packs, sizeOfBlob],
    [PICTURE_STORES.loose, entry => sizeOfBlob(entry?.blob)],
  ]).catch(() => null)
}

const recordSize = record => {
  try {
    return JSON.stringify(record)?.length ?? 0
  } catch {
    return 0
  }
}

/** Saved pages: the read cache records (JSON characters, like the cache's own size caps). `null` if unreadable. */
export function readCacheBytes({ indexedDB = globalThis.indexedDB } = {}) {
  return sumDatabase(indexedDB, READ_CACHE_DB_NAME, [[READ_CACHE_STORE, recordSize]]).catch(() => null)
}

/** The browser's figure for the whole app: `{ usage, quota }`, or nulls. */
export async function browserUsage({ storage = globalThis.navigator?.storage } = {}) {
  try {
    const estimate = storage?.estimate ? await storage.estimate() : null
    return { usage: estimate?.usage ?? null, quota: estimate?.quota ?? null }
  } catch {
    return { usage: null, quota: null }
  }
}

/** All the figures; each one is `null` when it cannot be read. `waiting` (outbox photos) comes from the caller. */
export async function loadStorageBreakdown({ languages, waiting, indexedDB, storage } = {}) {
  const [pictures, pages, total] = await Promise.all([
    pictureBytes({ indexedDB }),
    readCacheBytes({ indexedDB }),
    browserUsage({ storage }),
  ])
  return {
    cardData: cardDataBytes(languages),
    pictures,
    pages,
    waiting: waiting ?? null,
    usage: total.usage,
    quota: total.quota,
  }
}
