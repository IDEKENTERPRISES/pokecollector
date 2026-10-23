// The downloaded card pictures (F16a). A set's pictures are kept as ONE Blob (the pack as the server
// sent it) in IndexedDB, plus a small index from card id to {pack, offset, length, type}. The service
// worker answers /api/images/card/{id}/small by slicing the pack Blob; a slice does not read the pack.
//
// Why not Cache Storage: ~22,000 entries in one cache made WebKit's first Cache Storage access of
// every launch take seconds (it appears to read every cache's record list). About 200 Blobs and one
// index store keep it cheap. This module is the page side; sw/sw.js reads the same database with the
// same names (a test keeps the two in step).
//
// Stores: `packs` (`<lang>|<setId>` -> Blob), `index` (card id -> { p, o, l, t, lang }, with an index on
// `p` and on `lang`) and `loose` (picture path -> { blob, t, lang }): the few pictures a pack did not
// carry, and set logos and symbols. Every access is guarded by the caller: a failure means "no pictures".

export const PICTURE_DB_NAME = 'pokecollector-pictures'
export const PICTURE_DB_VERSION = 1
export const PICTURE_STORES = Object.freeze({ packs: 'packs', index: 'index', loose: 'loose' })

export const packKey = (lang, setId) => `${lang}|${setId}`

function openDb(indexedDB) {
  return new Promise((resolve, reject) => {
    if (!indexedDB) {
      reject(new Error('IndexedDB is not available'))
      return
    }
    let request
    try {
      request = indexedDB.open(PICTURE_DB_NAME, PICTURE_DB_VERSION)
    } catch (error) {
      reject(error)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore(PICTURE_STORES.packs)
      const index = db.createObjectStore(PICTURE_STORES.index)
      index.createIndex('p', 'p')
      index.createIndex('lang', 'lang')
      db.createObjectStore(PICTURE_STORES.loose).createIndex('lang', 'lang')
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
    request.onblocked = () => reject(new Error('IndexedDB open is blocked'))
  })
}

const promisify = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error)
})

const txDone = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onerror = () => reject(tx.error)
  tx.onabort = () => reject(tx.error || new Error('transaction aborted'))
})

/** Deletes every record of one index value (e.g. a language) from an object store, inside `tx`. */
function deleteByIndex(tx, storeName, indexName, value) {
  return new Promise((resolve, reject) => {
    const store = tx.objectStore(storeName)
    const request = store.index(indexName).openKeyCursor(IDBKeyRange.only(value))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve()
        return
      }
      store.delete(cursor.primaryKey)
      cursor.continue()
    }
    request.onerror = () => reject(request.error)
  })
}

export function createPictureStore({ indexedDB = globalThis.indexedDB } = {}) {
  let dbPromise = null
  const db = () => {
    if (!dbPromise) {
      dbPromise = openDb(indexedDB).catch(error => {
        dbPromise = null
        throw error
      })
    }
    return dbPromise
  }

  return {
    /**
     * Saves a set's pack and the index of its pictures in one transaction. `items` are
     * `{ id, offset, length, type }` positions inside `blob`.
     */
    async putPack({ lang, setId, blob, items }) {
      const handle = await db()
      const tx = handle.transaction([PICTURE_STORES.packs, PICTURE_STORES.index], 'readwrite')
      const done = txDone(tx)
      const key = packKey(lang, setId)
      tx.objectStore(PICTURE_STORES.packs).put(blob, key)
      const index = tx.objectStore(PICTURE_STORES.index)
      for (const item of items) index.put({ p: key, o: item.offset, l: item.length, t: item.type, lang }, item.id)
      await done
    },

    /** Saves one picture a pack did not carry (or a set logo/symbol) under its URL path. */
    async putLoose({ lang, path, blob, type }) {
      const handle = await db()
      const tx = handle.transaction(PICTURE_STORES.loose, 'readwrite')
      const done = txDone(tx)
      tx.objectStore(PICTURE_STORES.loose).put({ blob, t: type, lang }, path)
      await done
    },

    /** The URL paths of every stored picture (cards by `pathOfCard(id)`, loose ones as saved). */
    async knownPaths(pathOfCard) {
      const handle = await db()
      const tx = handle.transaction([PICTURE_STORES.index, PICTURE_STORES.loose], 'readonly')
      const [ids, loose] = await Promise.all([
        promisify(tx.objectStore(PICTURE_STORES.index).getAllKeys()),
        promisify(tx.objectStore(PICTURE_STORES.loose).getAllKeys()),
      ])
      const paths = new Set(loose)
      for (const id of ids) paths.add(pathOfCard(id))
      return paths
    },

    /** The picture of a card as a Blob (a slice of its pack), or null. */
    async getCard(cardId) {
      const handle = await db()
      const entry = await promisify(handle.transaction(PICTURE_STORES.index, 'readonly').objectStore(PICTURE_STORES.index).get(cardId))
      if (!entry) return null
      const pack = await promisify(handle.transaction(PICTURE_STORES.packs, 'readonly').objectStore(PICTURE_STORES.packs).get(entry.p))
      return pack ? pack.slice(entry.o, entry.o + entry.l, entry.t) : null
    },

    async getLoose(path) {
      const handle = await db()
      const entry = await promisify(handle.transaction(PICTURE_STORES.loose, 'readonly').objectStore(PICTURE_STORES.loose).get(path))
      return entry ? entry.blob.slice(0, entry.blob.size, entry.t) : null
    },

    /** How many pictures are stored for a language (cards in packs plus loose ones). */
    async count(lang) {
      const handle = await db()
      const tx = handle.transaction([PICTURE_STORES.index, PICTURE_STORES.loose], 'readonly')
      const [cards, loose] = await Promise.all([
        promisify(tx.objectStore(PICTURE_STORES.index).index('lang').count(IDBKeyRange.only(lang))),
        promisify(tx.objectStore(PICTURE_STORES.loose).index('lang').count(IDBKeyRange.only(lang))),
      ])
      return cards + loose
    },

    async deleteLanguage(lang) {
      const handle = await db()
      const tx = handle.transaction(Object.values(PICTURE_STORES), 'readwrite')
      const done = txDone(tx)
      tx.objectStore(PICTURE_STORES.packs).delete(IDBKeyRange.bound(`${lang}|`, `${lang}|￿`))
      await Promise.all([
        deleteByIndex(tx, PICTURE_STORES.index, 'lang', lang),
        deleteByIndex(tx, PICTURE_STORES.loose, 'lang', lang),
      ])
      await done
    },

    async clearAll() {
      const handle = await db()
      const tx = handle.transaction(Object.values(PICTURE_STORES), 'readwrite')
      const done = txDone(tx)
      for (const name of Object.values(PICTURE_STORES)) tx.objectStore(name).clear()
      await done
    },

    async close() {
      if (!dbPromise) return
      const handle = await dbPromise.catch(() => null)
      dbPromise = null
      handle?.close()
    },
  }
}
