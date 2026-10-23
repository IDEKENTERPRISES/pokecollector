import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { createPictureStore } from './carddb/pictureStore.js'
import { READ_CACHE_DB_NAME, READ_CACHE_DB_VERSION, READ_CACHE_STORE } from './readCache.js'
import { browserUsage, cardDataBytes, formatSize, loadStorageBreakdown, pictureBytes, readCacheBytes } from './storageBreakdown.js'

describe('formatSize', () => {
  it('uses KB, MB or GB with one decimal and a space', () => {
    expect(formatSize(0)).toBe('0.0 KB')
    expect(formatSize(2048)).toBe('2.0 KB')
    expect(formatSize(110.9 * 1024 * 1024)).toBe('110.9 MB')
    expect(formatSize(38.4 * 1024 ** 3)).toBe('38.4 GB')
    expect(formatSize(1024 * 1024)).toBe('1.0 MB')
  })
  it('is null for an unknown figure', () => {
    expect(formatSize(null)).toBeNull()
    expect(formatSize(undefined)).toBeNull()
    expect(formatSize(Number.NaN)).toBeNull()
  })
})

describe('cardDataBytes', () => {
  it('adds the languages that have data', () => {
    expect(cardDataBytes({ en: { meta: {}, bytes: 100 }, de: { meta: {}, bytes: 50 }, fr: { bytes: 9 } })).toBe(150)
    expect(cardDataBytes({})).toBe(0)
    expect(cardDataBytes(undefined)).toBeNull()
  })
})

describe('pictureBytes', () => {
  it('is 0 without a picture database, and does not create one', async () => {
    const indexedDB = new IDBFactory()
    expect(await pictureBytes({ indexedDB })).toBe(0)
    expect((await indexedDB.databases()).length).toBe(0)
  })
  it('sums packs and loose pictures', async () => {
    const indexedDB = new IDBFactory()
    const store = createPictureStore({ indexedDB })
    await store.putPack({ lang: 'en', setId: 'sv1', blob: new Blob(['AAbbbCC']), items: [{ id: 'sv1-1', offset: 0, length: 7, type: 'image/webp' }] })
    await store.putLoose({ lang: 'en', path: '/x', blob: new Blob(['LLL']), type: 'image/png' })
    expect(await pictureBytes({ indexedDB })).toBe(10)
  })
  it('is null when IndexedDB is missing', async () => {
    expect(await pictureBytes({ indexedDB: null })).toBeNull()
  })
})

describe('readCacheBytes', () => {
  it('sums the saved records', async () => {
    const indexedDB = new IDBFactory()
    await new Promise((resolve, reject) => {
      const open = indexedDB.open(READ_CACHE_DB_NAME, READ_CACHE_DB_VERSION)
      open.onupgradeneeded = () => open.result.createObjectStore(READ_CACHE_STORE)
      open.onsuccess = () => {
        const tx = open.result.transaction(READ_CACHE_STORE, 'readwrite')
        tx.objectStore(READ_CACHE_STORE).put({ a: 'xxxx' }, 'k')
        tx.oncomplete = () => { open.result.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      }
    })
    expect(await readCacheBytes({ indexedDB })).toBe(JSON.stringify({ a: 'xxxx' }).length)
  })
  it('is 0 when nothing is saved', async () => {
    expect(await readCacheBytes({ indexedDB: new IDBFactory() })).toBe(0)
  })
})

describe('browserUsage and loadStorageBreakdown', () => {
  it('reports the browser estimate, or nulls', async () => {
    expect(await browserUsage({ storage: { estimate: async () => ({ usage: 5, quota: 9 }) } })).toEqual({ usage: 5, quota: 9 })
    expect(await browserUsage({ storage: undefined })).toEqual({ usage: null, quota: null })
    expect(await browserUsage({ storage: { estimate: async () => { throw new Error('x') } } })).toEqual({ usage: null, quota: null })
  })
  it('puts every figure together', async () => {
    const result = await loadStorageBreakdown({
      languages: { en: { meta: {}, bytes: 1000 } },
      waiting: 0,
      indexedDB: new IDBFactory(),
      storage: { estimate: async () => ({ usage: 2000, quota: 4000 }) },
    })
    expect(result).toEqual({ cardData: 1000, pictures: 0, pages: 0, waiting: 0, usage: 2000, quota: 4000 })
  })
})
