import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OUTBOX_DB_NAME } from './constants.js'
import { openOutboxDb, promisify } from './outbox/db.js'
import { persist, purgeOthers } from './readCache.js'
import { SETTINGS_CACHE_KEY } from './settingsCache.js'
import { SNAPSHOT_KEY } from './authSnapshot.js'
import {
  KEEP_CARD_PICTURES_ON_SIGN_OUT,
  PICTURE_CACHE_PREFIX,
  VIEWED_IMAGES_CACHE,
  clearAllUserData,
  clearImageCaches,
  clearOtherUsersData,
  clearUserStorageKeys,
} from './sessionCleanup.js'

let indexedDB

const memoryStorage = () => {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: key => { map.delete(key) },
    clear: () => map.clear(),
  }
}
const localStorage = memoryStorage()
const sessionStorage = memoryStorage()

class FakeCaches {
  constructor(names) { this.names = new Set(names) }
  async keys() { return [...this.names] }
  async delete(name) { return this.names.delete(name) }
}

async function seedOutbox() {
  const db = await openOutboxDb({ indexedDB })
  const tx = db.transaction(['items', 'photos', 'history'], 'readwrite')
  tx.objectStore('items').put({ id: 'a', userId: 1, serverOrigin: 'o', state: 'pending' })
  tx.objectStore('items').put({ id: 'b', userId: 2, serverOrigin: 'o', state: 'pending' })
  tx.objectStore('photos').put({ itemId: 'a', index: 0, blob: 'x' })
  tx.objectStore('photos').put({ itemId: 'b', index: 0, blob: 'y' })
  tx.objectStore('history').put({ id: 'h', completedAt: 1 })
  await new Promise(resolve => { tx.oncomplete = resolve })
  db.close()
}

async function outboxRows() {
  const db = await openOutboxDb({ indexedDB })
  const rows = {
    items: (await promisify(db.transaction('items').objectStore('items').getAllKeys())).sort(),
    photos: (await promisify(db.transaction('photos').objectStore('photos').getAllKeys())).map(key => key[0]).sort(),
    history: await promisify(db.transaction('history').objectStore('history').getAllKeys()),
  }
  db.close()
  return rows
}

const databases = () => indexedDB.databases().then(list => list.map(entry => entry.name))

async function saveReadCache(userId) {
  const client = new QueryClient()
  client.setQueryData(['collection', {}], [{ id: 1 }])
  const persister = persist(client, { origin: 'o', userId, indexedDB })
  await persister.flush()
  await persister.stop()
}

beforeEach(() => {
  indexedDB = new IDBFactory()
  globalThis.indexedDB = indexedDB
  vi.stubGlobal('localStorage', localStorage)
  vi.stubGlobal('sessionStorage', sessionStorage)
  localStorage.clear()
  sessionStorage.clear()
})

describe('clearAllUserData', () => {
  it("removes the user's data and keeps the card database and pictures", async () => {
    await seedOutbox()
    await saveReadCache(1)
    await new Promise(resolve => { const r = indexedDB.open('pokecollector-carddb', 1); r.onsuccess = () => { r.result.close(); resolve() } })
    localStorage.setItem(SETTINGS_CACHE_KEY, '{}')
    localStorage.setItem(SNAPSHOT_KEY, '{}')
    localStorage.setItem('lastUser', 'ash')
    localStorage.setItem('pc.outbox.canary', 'id')
    localStorage.setItem('pc-carddb-prefs', '{"enabled":true}')
    const cacheStorage = new FakeCaches([VIEWED_IMAGES_CACHE, `${PICTURE_CACHE_PREFIX}en`, 'pc-shell-b2'])

    await clearAllUserData({ indexedDB, cacheStorage })

    expect(await databases()).not.toContain(OUTBOX_DB_NAME)
    expect(await databases()).toContain('pokecollector-carddb')
    const db = await new Promise(resolve => { const r = indexedDB.open('pokecollector-readcache', 1); r.onsuccess = () => resolve(r.result) })
    expect(await promisify(db.transaction('qc').objectStore('qc').getAllKeys())).toEqual([])
    db.close()
    expect([...cacheStorage.names].sort()).toEqual([`${PICTURE_CACHE_PREFIX}en`, 'pc-shell-b2'].sort())
    expect(localStorage.getItem(SETTINGS_CACHE_KEY)).toBeNull()
    expect(localStorage.getItem(SNAPSHOT_KEY)).toBeNull()
    expect(localStorage.getItem('lastUser')).toBeNull()
    expect(localStorage.getItem('pc.outbox.canary')).toBeNull()
    expect(localStorage.getItem('pc-carddb-prefs')).not.toBeNull()
  })

  it('keeps the outbox (and its marker) when the user chose to keep unsynced changes', async () => {
    await seedOutbox()
    localStorage.setItem('pc.outbox.canary', 'id')
    await clearAllUserData({ indexedDB, cacheStorage: new FakeCaches([]), keepOutbox: true })
    expect(await databases()).toContain(OUTBOX_DB_NAME)
    expect((await outboxRows()).items).toEqual(['a', 'b'])
    expect(localStorage.getItem('pc.outbox.canary')).toBe('id')
  })

  it('removes the downloaded pictures too when the switch is off', async () => {
    expect(KEEP_CARD_PICTURES_ON_SIGN_OUT).toBe(true)
    const cacheStorage = new FakeCaches([VIEWED_IMAGES_CACHE, `${PICTURE_CACHE_PREFIX}en`])
    await clearImageCaches({ cacheStorage, keepPictures: false })
    expect(cacheStorage.names.size).toBe(0)
  })

  it('never throws without storage', async () => {
    await expect(clearAllUserData({ indexedDB: null, cacheStorage: null })).resolves.toBeUndefined()
    expect(() => clearUserStorageKeys({ localStorage: null, sessionStorage: null })).not.toThrow()
  })
})

describe('clearOtherUsersData', () => {
  it("removes another user's queued items, photos, history and viewed pictures", async () => {
    await seedOutbox()
    await saveReadCache(1)
    const removed = await purgeOthers({ origin: 'o', keepUserId: 2, indexedDB })
    expect(removed).toBe(2) // record + head of user 1
    const cacheStorage = new FakeCaches([VIEWED_IMAGES_CACHE, `${PICTURE_CACHE_PREFIX}en`])
    const found = await clearOtherUsersData({ keepUserId: 2, readCacheRemoved: removed, indexedDB, cacheStorage })
    expect(found).toBe(true)
    expect(await outboxRows()).toEqual({ items: ['b'], photos: ['b'], history: [] })
    expect([...cacheStorage.names]).toEqual([`${PICTURE_CACHE_PREFIX}en`])
  })

  it('does nothing when only the same user is there', async () => {
    const cacheStorage = new FakeCaches([VIEWED_IMAGES_CACHE])
    const found = await clearOtherUsersData({ keepUserId: 1, readCacheRemoved: 0, indexedDB, cacheStorage })
    expect(found).toBe(false)
    expect(cacheStorage.names.has(VIEWED_IMAGES_CACHE)).toBe(true)
  })
})
