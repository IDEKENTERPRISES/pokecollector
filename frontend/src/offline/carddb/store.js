// The offline card database's own IndexedDB (F13): never the outbox's or the read cache's.
// Stores: `sets` (one record per set with all its cards), `setIndex` (small record per set: hash,
// card count, bytes, so the sync can diff without reading card data), `prices` (one per language)
// and `meta` (one per language: what the last complete sync stored). Every access is guarded:
// a failure means the feature is off (functions return their fallback), never a crash.

export const CARDDB_DB_NAME = 'pokecollector-carddb'
export const CARDDB_DB_VERSION = 1
export const STORES = Object.freeze({ sets: 'sets', setIndex: 'setIndex', prices: 'prices', meta: 'meta' })

const setKey = (lang, setId) => `${lang}|${setId}`
const rangeFor = lang => IDBKeyRange.bound(`${lang}|`, `${lang}|￿`)

function openDb(indexedDB) {
  return new Promise((resolve, reject) => {
    if (!indexedDB) {
      reject(new Error('IndexedDB is not available'))
      return
    }
    let request
    try {
      request = indexedDB.open(CARDDB_DB_NAME, CARDDB_DB_VERSION)
    } catch (error) {
      reject(error)
      return
    }
    request.onupgradeneeded = () => {
      for (const name of Object.values(STORES)) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name)
      }
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
  tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'))
  tx.onerror = () => reject(tx.error)
})

/**
 * Creates the store. `indexedDB` is injectable for tests. Every method resolves a fallback
 * (null / false / empty) when IndexedDB is missing, full or blocked.
 */
export function createCardDbStore(indexedDB = globalThis.indexedDB) {
  async function run(storeNames, mode, work, fallback) {
    let db = null
    try {
      db = await openDb(indexedDB)
      const tx = db.transaction(storeNames, mode)
      const done = txDone(tx)
      done.catch(() => {})
      const stores = Object.fromEntries(storeNames.map(name => [name, tx.objectStore(name)]))
      const result = await work(stores)
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

  return {
    /** True when the database can be opened and written (storage failure means "off"). */
    available: () => run([STORES.meta], 'readwrite', async ({ meta }) => {
      meta.put(Date.now(), '__probe')
      meta.delete('__probe')
      return true
    }, false),

    getMeta: lang => run([STORES.meta], 'readonly', ({ meta }) => promisify(meta.get(lang)).then(value => value ?? null), null),
    setMeta: (lang, value) => run([STORES.meta], 'readwrite', async ({ meta }) => {
      meta.put(value, lang)
      return true
    }, false),

    /** Map of setId -> hash for the sets stored for a language. */
    async listSetHashes(lang) {
      const rows = await run([STORES.setIndex], 'readonly', ({ setIndex }) => (
        promisify(setIndex.getAll(rangeFor(lang))).then(values => values)
      ), [])
      return new Map(rows.map(row => [row.setId, row.hash]))
    },

    /** One set's payload ({ set, fields, cards }) saved together with its index row. */
    putSet: (lang, setId, { hash, bytes, payload }) => run([STORES.sets, STORES.setIndex], 'readwrite', async ({ sets, setIndex }) => {
      sets.put(payload, setKey(lang, setId))
      setIndex.put({ lang, setId, hash, bytes: bytes || 0, cards: payload?.cards?.length ?? 0 }, setKey(lang, setId))
      return true
    }, false),

    deleteSets: (lang, setIds) => run([STORES.sets, STORES.setIndex], 'readwrite', async ({ sets, setIndex }) => {
      for (const setId of setIds) {
        sets.delete(setKey(lang, setId))
        setIndex.delete(setKey(lang, setId))
      }
      return true
    }, false),

    getSet: (lang, setId) => run([STORES.sets], 'readonly', ({ sets }) => promisify(sets.get(setKey(lang, setId))).then(value => value ?? null), null),
    getAllSets: lang => run([STORES.sets], 'readonly', ({ sets }) => promisify(sets.getAll(rangeFor(lang))), []),

    putPrices: (lang, value) => run([STORES.prices], 'readwrite', async ({ prices }) => {
      prices.put(value, lang)
      return true
    }, false),
    getPrices: lang => run([STORES.prices], 'readonly', ({ prices }) => promisify(prices.get(lang)).then(value => value ?? null), null),

    /** Removes everything stored for one language. */
    deleteLanguage: lang => run(Object.values(STORES), 'readwrite', async ({ sets, setIndex, prices, meta }) => {
      sets.delete(rangeFor(lang))
      setIndex.delete(rangeFor(lang))
      prices.delete(lang)
      meta.delete(lang)
      return true
    }, false),

    /** Languages that currently have stored data. */
    listLanguages: () => run([STORES.meta], 'readonly', ({ meta }) => promisify(meta.getAllKeys()), []),

    /** Bytes of downloaded card data per language (compressed sizes from the manifest). */
    async usage(lang) {
      const rows = await run([STORES.setIndex, STORES.meta], 'readonly', async ({ setIndex, meta }) => ({
        sets: await promisify(setIndex.getAll(rangeFor(lang))),
        meta: await promisify(meta.get(lang)),
      }), { sets: [], meta: null })
      return rows.sets.reduce((sum, row) => sum + (row.bytes || 0), 0) + (rows.meta?.pricesBytes || 0)
    },

    clearAll: () => run(Object.values(STORES), 'readwrite', async stores => {
      for (const store of Object.values(stores)) store.clear()
      return true
    }, false),
  }
}
