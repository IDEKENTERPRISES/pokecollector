// What leaves the device on sign-out, and when a different user signs in (F15c). Everything about the
// signed-in user goes: the read cache, the outbox, the settings and sign-in caches, the viewed-image
// cache and per-user localStorage keys. The offline card database (cards, sets, prices) stays, as do the
// downloaded TCG card pictures, because they hold no user data. Every access is guarded: a failure
// never traps the user in the app.

import { OUTBOX_DB_NAME } from './constants.js'
import { CANARY_STORAGE_KEY } from './durability.js'
import { purgeAll } from './readCache.js'
import { clearSettingsCache } from './settingsCache.js'
import { clearAuthSnapshot } from './authSnapshot.js'
import { openOutboxDb, promisify, txDone } from './outbox/db.js'

// The service worker's cache of pictures seen while browsing. It can hold the user's own card photos.
export const VIEWED_IMAGES_CACHE = 'pc-images-v1'
export const PICTURE_CACHE_PREFIX = 'pc-carddb-images-v1-'

/** One-line switch: true keeps the downloaded TCG card pictures on sign-out, false removes them too. */
export const KEEP_CARD_PICTURES_ON_SIGN_OUT = true

// localStorage keys that describe the signed-in user (not the device): the login page's "welcome back",
// remembered tabs and navigation history, the last sync time. The token and `user` are the caller's.
export const USER_LOCAL_STORAGE_KEYS = [
  'lastUser',
  'lastUserAvatar',
  'pc.nav.history.v1',
  'pc.tabs.v1',
  'pc.sync.lastSyncedAt',
]

const LIST_SCROLL_PREFIX = 'pokecollector:list-scroll:'
const DELETE_TIMEOUT_MS = 1500

function storageOf(kind) {
  try {
    return globalThis[kind] ?? null
  } catch {
    return null
  }
}

// The outbox database's marker (see durability.js) goes with the database, not before it.
export function clearUserStorageKeys({ localStorage = storageOf('localStorage'), sessionStorage = storageOf('sessionStorage'), withOutboxMarker = false } = {}) {
  for (const key of withOutboxMarker ? [...USER_LOCAL_STORAGE_KEYS, CANARY_STORAGE_KEY] : USER_LOCAL_STORAGE_KEYS) {
    try {
      localStorage?.removeItem(key)
    } catch {
      // best effort
    }
  }
  try {
    for (const key of Object.keys(sessionStorage ?? {})) {
      if (key.startsWith(LIST_SCROLL_PREFIX)) sessionStorage.removeItem(key) // saved list scroll positions
    }
  } catch {
    // best effort
  }
}

/** Deletes the viewed-image cache (and the card pictures when `keepPictures` is false). → names deleted. */
export async function clearImageCaches({ cacheStorage = globalThis.caches, keepPictures = KEEP_CARD_PICTURES_ON_SIGN_OUT } = {}) {
  const deleted = []
  if (!cacheStorage) return deleted
  try {
    const names = await cacheStorage.keys()
    for (const name of names) {
      if (name === VIEWED_IMAGES_CACHE || (!keepPictures && name.startsWith(PICTURE_CACHE_PREFIX))) {
        if (await cacheStorage.delete(name)) deleted.push(name)
      }
    }
  } catch {
    // best effort
  }
  return deleted
}

/** Deletes the whole outbox database. Gives up quietly after a short wait (a connection that stays open). */
export function deleteOutboxDatabase({ indexedDB = globalThis.indexedDB, timeoutMs = DELETE_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    if (!indexedDB) {
      resolve(false)
      return
    }
    const timer = setTimeout(() => resolve(false), timeoutMs)
    const finish = ok => {
      clearTimeout(timer)
      resolve(ok)
    }
    try {
      const request = indexedDB.deleteDatabase(OUTBOX_DB_NAME)
      request.onsuccess = () => finish(true)
      request.onerror = () => finish(false)
    } catch {
      finish(false)
    }
  })
}

/** Removes the queued items of every user except `keepUserId`, with their photos, and the sent-items log. */
export async function clearOutboxOfOthers({ keepUserId, indexedDB = globalThis.indexedDB } = {}) {
  let db = null
  try {
    db = await openOutboxDb({ indexedDB })
    const tx = db.transaction(['items', 'photos', 'history'], 'readwrite')
    const done = txDone(tx)
    done.catch(() => {})
    const items = tx.objectStore('items')
    const photos = tx.objectStore('photos')
    const rows = await promisify(items.getAll())
    const gone = new Set()
    for (const item of rows) {
      if (item.userId === keepUserId) continue
      gone.add(item.id)
      items.delete(item.id)
    }
    if (gone.size > 0) {
      const photoKeys = await promisify(photos.getAllKeys())
      for (const key of photoKeys) if (gone.has(Array.isArray(key) ? key[0] : key)) photos.delete(key)
    }
    tx.objectStore('history').clear()
    await done
    return gone.size
  } catch {
    return 0
  } finally {
    try {
      db?.close()
    } catch {
      // already closed
    }
  }
}

/**
 * Sign-out: everything about the user goes, bar the card database. `keepOutbox` is for a logout where the
 * user chose "keep" for unsynced changes: those items stay (they belong to that user and are only ever
 * replayed for them). Never throws.
 */
export async function clearAllUserData({
  keepOutbox = false,
  keepPictures = KEEP_CARD_PICTURES_ON_SIGN_OUT,
  indexedDB = globalThis.indexedDB,
  cacheStorage = globalThis.caches,
} = {}) {
  const steps = [
    purgeAll({ indexedDB }),
    clearImageCaches({ cacheStorage, keepPictures }),
    Promise.resolve().then(() => {
      clearSettingsCache()
      clearAuthSnapshot()
      clearUserStorageKeys({ withOutboxMarker: !keepOutbox })
    }),
  ]
  if (!keepOutbox) steps.push(deleteOutboxDatabase({ indexedDB }))
  await Promise.allSettled(steps)
}

/**
 * A different user signed in: the previous user's local data goes. `readCacheRemoved` is what `purgeOthers`
 * deleted; any trace of another user (saved pages or queued items) also clears the viewed-image cache,
 * which can hold that user's own card photos. Runs on every start but only acts when there is something.
 * → true when another user's data was found.
 */
export async function clearOtherUsersData({ keepUserId, readCacheRemoved = 0, indexedDB = globalThis.indexedDB, cacheStorage = globalThis.caches } = {}) {
  const outboxRemoved = await clearOutboxOfOthers({ keepUserId, indexedDB })
  const found = readCacheRemoved > 0 || outboxRemoved > 0
  if (found) await clearImageCaches({ cacheStorage, keepPictures: true })
  return found
}
