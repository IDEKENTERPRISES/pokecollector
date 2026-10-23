import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PREFS_KEY, SYNC_THROTTLE_MS, createCardDbController, createFetchJson, readPrefs, wantedLanguages } from './controller.js'
import { statusError } from './net.js'
import { buildPack } from './packFixture.js'
import { MIGRATION_NOTICE_KEY } from './pictureMigration.js'
import { createPictureStore } from './pictureStore.js'
import { cardPictureUrl, pictureCacheName, pictureUrlsFor, setPictureUrl } from './pictures.js'
import { createCardDbStore } from './store.js'
import { MANIFEST_PATH } from './sync.js'

const memoryStorage = () => {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
}

function fakeCaches() {
  const caches = new Map()
  const open = async name => {
    if (!caches.has(name)) caches.set(name, new Map())
    const entries = caches.get(name)
    return { match: async url => entries.get(url), put: async (url, response) => { entries.set(url, response) } }
  }
  return { caches, open, remove: async name => caches.delete(name), keys: async () => [...caches.keys()] }
}

const imageResponse = () => ({ status: 200, headers: { get: () => 'image/webp' }, blob: async () => new Blob([new Uint8Array(4)]) })

function setup({ manifest, online = true, ...extra } = {}) {
  const store = createCardDbStore(new IDBFactory())
  const storage = memoryStorage()
  const cacheApi = fakeCaches()
  const pictureStore = createPictureStore({ indexedDB: new IDBFactory() })
  const state = { manifest, online, requests: [] }
  const fetchJson = async path => {
    state.requests.push(path)
    if (path === MANIFEST_PATH) return state.manifest ? { status: 200, data: state.manifest } : { status: 404 }
    if (path.includes('/prices/')) return { status: 200, data: { fields: ['price_market'], rows: [] } }
    const setId = decodeURIComponent(path.split('/').pop())
    return {
      status: 200,
      data: { set: { id: setId, images_logo: 'logo.webp', images_symbol: 'symbol.webp' }, fields: ['id', 'images_small'], cards: [[`${setId}-1`, 'a.webp'], [`${setId}-2`, null]] },
    }
  }
  const fetchImage = vi.fn(async () => imageResponse())
  const fetchPack = vi.fn(async path => {
    const setId = decodeURIComponent(path.split('/').pop())
    return { status: 200, buffer: buildPack([{ id: `${setId}-1`, bytes: new Uint8Array(10) }]) }
  })
  const controller = createCardDbController({
    store,
    fetchJson,
    fetchImage,
    fetchPack,
    sleep: async () => {},
    pictureStore,
    deleteCache: cacheApi.remove,
    listCaches: cacheApi.keys,
    storage,
    isOnline: () => state.online,
    requestPersist: vi.fn(async () => true),
    now: () => state.now ?? Date.now(),
    ...extra,
  })
  return { controller, store, storage, state, cacheApi, pictureStore, fetchImage, fetchPack }
}

const manifest = () => ({
  languages: {
    en: { hash: 'L1', prices_hash: 'P1', prices_bytes: 10, card_count: 4, sets: [{ id: 'a_en', hash: 'h1', bytes: 100 }, { id: 'b_en', hash: 'h2', bytes: 100 }] },
    de: { hash: 'L2', prices_hash: 'P2', prices_bytes: 10, card_count: 2, sets: [{ id: 'a_de', hash: 'd1', bytes: 50 }] },
  },
})

describe('preferences', () => {
  it('defaults to card data on for every language and pictures off', () => {
    const prefs = readPrefs(memoryStorage())
    expect(prefs.enabled).toBe(true)
    expect(wantedLanguages(prefs, ['en', 'de'])).toEqual(['en', 'de'])
    expect(prefs.pictures.en).toBeUndefined()
  })
  it('honours switched-off languages and the device switch, and survives corrupt storage', () => {
    expect(wantedLanguages({ enabled: true, languages: { de: false }, pictures: {} }, ['en', 'de'])).toEqual(['en'])
    expect(wantedLanguages({ enabled: false, languages: {}, pictures: {} }, ['en'])).toEqual([])
    const storage = memoryStorage()
    storage.setItem(PREFS_KEY, '{nope')
    expect(readPrefs(storage).enabled).toBe(true)
  })
})

describe('createFetchJson', () => {
  it('sends the token, retries a throttled answer, and maps 404 to a status', async () => {
    const answers = [
      { status: 429, ok: false, headers: new Headers({ 'Retry-After': '1' }) },
      { status: 200, ok: true, headers: new Headers({ ETag: '"abc"' }), json: async () => ({ ok: 1 }) },
    ]
    const fetchImpl = vi.fn(async () => answers.shift())
    const sleep = vi.fn(async () => {})
    const fetchJson = createFetchJson({ fetchImpl, getToken: () => 'tok', sleep })
    expect(await fetchJson('/x')).toEqual({ status: 200, data: { ok: 1 }, etag: 'abc' })
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer tok')
    expect(sleep).toHaveBeenCalledWith(1000)
    const missing = createFetchJson({ fetchImpl: async () => ({ status: 404, ok: false, headers: new Headers() }), getToken: () => null, sleep })
    expect(await missing('/y')).toEqual({ status: 404 })
  })
})

describe('controller sync', () => {
  it('downloads the wanted languages on the first run and nothing on a second run', async () => {
    const { controller, state, store } = setup({ manifest: manifest() })
    await controller.sync({ force: true })
    expect(controller.getSnapshot()).toMatchObject({ status: 'idle', serverEnabled: true, available: ['en', 'de'] })
    expect((await store.listLanguages()).sort()).toEqual(['de', 'en'])
    state.requests.length = 0
    await controller.sync({ force: true })
    expect(state.requests).toEqual([MANIFEST_PATH])
    expect(controller.getSnapshot().languages.en.meta.hash).toBe('L1')
  })

  it('does not re-run within the throttle window unless forced, and never while offline', async () => {
    const { controller, state } = setup({ manifest: manifest() })
    state.now = 1_000_000
    await controller.sync()
    state.requests.length = 0
    state.now += SYNC_THROTTLE_MS - 1
    expect(await controller.sync()).toBeNull()
    expect(state.requests).toEqual([])
    state.online = false
    expect(await controller.sync({ force: true })).toBeNull()
    expect(controller.getSnapshot().status).toBe('offline')
  })

  it('switching a language off deletes it, switching the device off removes everything', async () => {
    const { controller, store } = setup({ manifest: manifest() })
    await controller.sync({ force: true })
    await controller.setLanguage('de', false)
    expect(await store.listLanguages()).toEqual(['en'])
    await controller.setEnabled(false)
    expect(await store.listLanguages()).toEqual([])
    expect(controller.getSnapshot().prefs.enabled).toBe(false)
  })

  it('hides the feature when the server turns it off', async () => {
    const { controller, state } = setup({ manifest: manifest() })
    await controller.sync({ force: true })
    state.manifest = null
    await controller.sync({ force: true })
    expect(controller.getSnapshot()).toMatchObject({ serverEnabled: false, available: [] })
  })

  it('reports a storage failure as off instead of crashing', async () => {
    const { controller, store } = setup({ manifest: manifest() })
    store.available = async () => false
    await controller.sync({ force: true })
    expect(controller.getSnapshot()).toMatchObject({ status: 'error', storageOk: false })
  })
})

describe('pictures', () => {
  it('lists logos, symbols and small cards that have a picture', () => {
    const urls = pictureUrlsFor([{ set: { id: 'a_en', images_logo: 'l', images_symbol: 's' }, fields: ['id', 'images_small'], cards: [['a-1', 'x'], ['a-2', null]] }])
    expect(urls).toEqual([setPictureUrl('a_en', 'logo'), setPictureUrl('a_en', 'symbol'), cardPictureUrl('a-1')])
  })

  it('downloads into the picture store per language, resumes without refetching, and removes cleanly', async () => {
    const { controller, pictureStore, fetchPack, storage } = setup({ manifest: manifest() })
    await controller.sync({ force: true })
    await controller.startPictures('en')
    expect(controller.getSnapshot().languages.en.pictures).toMatchObject({ status: 'complete', doneSets: 2, totalSets: 2 })
    expect(controller.getSnapshot().languages.en.pictures.bytes).toBeGreaterThan(0)
    expect(await pictureStore.count('en')).toBeGreaterThan(0)
    expect(controller.getSnapshot().prefs.pictures.en).toBe(true)
    const calls = fetchPack.mock.calls.length
    await controller.startPictures('en')
    expect(fetchPack.mock.calls.length).toBe(calls) // every set is done already
    await controller.removePictures('en')
    expect(await pictureStore.count('en')).toBe(0)
    expect(controller.getSnapshot().languages.en.pictures.status).toBe('none')
    expect([...storage.keys?.() ?? []]).toEqual([])
    await controller.startPictures('en')
    expect(fetchPack.mock.calls.length).toBeGreaterThan(calls) // "remove" forgot the progress
  })

  it('pauses when the user pauses and resumes with the sets still to do', async () => {
    const { controller, fetchPack, pictureStore } = setup({ manifest: manifest() })
    await controller.sync({ force: true })
    fetchPack.mockImplementationOnce(async path => {
      controller.pausePictures('en')
      const setId = decodeURIComponent(path.split('/').pop())
      return { status: 200, buffer: buildPack([{ id: `${setId}-1`, bytes: new Uint8Array(10) }]) }
    })
    await controller.startPictures('en')
    expect(controller.getSnapshot().languages.en.pictures).toMatchObject({ status: 'paused', reason: 'user' })
    const finished = controller.getSnapshot().languages.en.pictures.doneSets
    expect(finished).toBeLessThan(2)
    fetchPack.mockClear()
    await controller.resumePictures('en')
    expect(controller.getSnapshot().languages.en.pictures.status).toBe('complete')
    expect(fetchPack).toHaveBeenCalledTimes(2 - finished)
    expect(await pictureStore.count('en')).toBeGreaterThan(0)
  })

  it('a stalled download pauses with a reason and a later Resume works (no stuck state)', async () => {
    const { controller, fetchPack, state } = setup({ manifest: manifest() })
    await controller.sync({ force: true })
    state.online = false
    fetchPack.mockImplementation(async () => { throw statusError(503) })
    await controller.startPictures('en')
    expect(controller.getSnapshot().languages.en.pictures).toMatchObject({ status: 'paused', reason: 'offline' })
    state.online = true
    fetchPack.mockImplementation(async () => { throw statusError(503) })
    await controller.startPictures('en')
    expect(controller.getSnapshot().languages.en.pictures).toMatchObject({ status: 'paused', reason: 'server' })
    fetchPack.mockImplementation(async path => ({ status: 200, buffer: buildPack([{ id: `${decodeURIComponent(path.split('/').pop())}-1`, bytes: new Uint8Array(3) }]) }))
    await controller.startPictures('en')
    expect(controller.getSnapshot().languages.en.pictures.status).toBe('complete')
  })

  it('resumeStalledPictures restarts a download that paused because the connection was lost', async () => {
    const { controller, fetchPack, state } = setup({ manifest: manifest() })
    await controller.sync({ force: true })
    state.online = false
    fetchPack.mockImplementation(async () => { throw statusError(503) })
    await controller.startPictures('en')
    state.online = true
    fetchPack.mockImplementation(async path => ({ status: 200, buffer: buildPack([{ id: `${decodeURIComponent(path.split('/').pop())}-1`, bytes: new Uint8Array(3) }]) }))
    controller.resumeStalledPictures()
    await vi.waitFor(() => expect(controller.getSnapshot().languages.en.pictures.status).toBe('complete'))
  })

  it('after an app restart the progress is read back: sets done of total, paused', async () => {
    const first = setup({ manifest: manifest() })
    await first.controller.sync({ force: true })
    first.fetchPack.mockImplementation(async path => {
      if (path.endsWith('/b_en')) {
        await new Promise(resolve => setTimeout(resolve, 100)) // a_en is stored first
        throw statusError(503)
      }
      return { status: 200, buffer: buildPack([{ id: 'a_en-1', bytes: new Uint8Array(3) }]) }
    })
    await first.controller.startPictures('en')
    const second = createCardDbController({ store: first.store, fetchJson: async () => ({ status: 404 }), storage: first.storage, pictureStore: first.pictureStore, deleteCache: first.cacheApi.remove, listCaches: first.cacheApi.keys })
    await second.hydrate()
    await second.inspectPictures('en')
    expect(second.getSnapshot().languages.en.pictures).toMatchObject({ status: 'paused', doneSets: 1, totalSets: 2 })
  })

  it('removing everything also deletes the pictures and any old picture caches', async () => {
    const { controller, cacheApi, pictureStore } = setup({ manifest: manifest() })
    await controller.sync({ force: true })
    await controller.startPictures('de')
    cacheApi.caches.set(pictureCacheName('en'), new Map())
    await controller.removeAll()
    expect(cacheApi.caches.size).toBe(0)
    expect(await pictureStore.count('de')).toBe(0)
  })

  it('picturesNeedRedownload is true after the migration and clears by itself once the pictures are downloaded again', async () => {
    const { controller, cacheApi, storage } = setup({ manifest: manifest() })
    await controller.sync({ force: true })
    cacheApi.caches.set(pictureCacheName('en'), new Map())
    expect(controller.getSnapshot().picturesNeedRedownload).toBe(false)
    await controller.migrateLegacyPictures()
    expect(controller.getSnapshot().picturesNeedRedownload).toBe(true)
    await controller.startPictures('en')
    expect(controller.getSnapshot()).toMatchObject({ picturesNeedRedownload: false, picturesMigrated: [] })
    expect(storage.getItem(MIGRATION_NOTICE_KEY)).toBeNull()
  })

  it('migrates old picture caches in the background: deleted, back to not downloaded, notice kept', async () => {
    const { controller, cacheApi, storage } = setup({ manifest: manifest() })
    await controller.sync({ force: true })
    storage.setItem('pc-carddb-prefs-v1', JSON.stringify({ enabled: true, languages: {}, pictures: { en: true } }))
    cacheApi.caches.set(pictureCacheName('en'), new Map([['x', 1]]))
    cacheApi.caches.set('pc-precache-1', new Map())
    await controller.migrateLegacyPictures()
    expect([...cacheApi.caches.keys()]).toEqual(['pc-precache-1'])
    expect(controller.getSnapshot().picturesMigrated).toEqual(['en'])
    expect(controller.getSnapshot().prefs.pictures.en).toBe(false)
    expect(JSON.parse(storage.getItem(MIGRATION_NOTICE_KEY))).toEqual(['en'])
    controller.dismissPicturesMigrationNotice()
    expect(controller.getSnapshot()).toMatchObject({ picturesMigrated: [], picturesNeedRedownload: false })
    // done once: a later start does not even list the caches
    const keys = vi.fn(async () => [])
    await createCardDbController({ store: controller === null ? null : setup().store, storage, listCaches: keys }).migrateLegacyPictures()
    expect(keys).not.toHaveBeenCalled()
  })
})

describe('stalled connections (hanging requests, navigator.onLine stays true)', () => {
  const okPack = path => ({ status: 200, buffer: buildPack([{ id: `${decodeURIComponent(path.split('/').pop())}-1`, bytes: new Uint8Array(3) }]) })

  it('pauses by itself when requests hang, and continues by itself when they answer again', async () => {
    const { controller, fetchPack } = setup({ manifest: manifest(), stallMs: 200, autoResumeBaseMs: 50 })
    await controller.sync({ force: true })
    fetchPack.mockImplementation(() => new Promise(() => {})) // never answers, ignores its signal
    const run = controller.startPictures('en')
    await run
    expect(controller.getSnapshot().languages.en.pictures).toMatchObject({ status: 'paused', reason: 'timeout' })
    fetchPack.mockImplementation(async path => okPack(path))
    await vi.waitFor(() => expect(controller.getSnapshot().languages.en.pictures.status).toBe('complete'), { timeout: 3000 })
  })

  it('pauses when the body stops after some bytes arrived', async () => {
    const { controller, fetchPack } = setup({ manifest: manifest(), stallMs: 200, autoResumeBaseMs: 60000 })
    await controller.sync({ force: true })
    fetchPack.mockImplementation(async (_path, _signal, onChunk) => {
      onChunk()
      return new Promise(() => {})
    })
    await controller.startPictures('en')
    expect(controller.getSnapshot().languages.en.pictures).toMatchObject({ status: 'paused', reason: 'timeout' })
    controller.pausePictures('en')
  })

  it('says no connection when the stall comes with the device offline', async () => {
    const { controller, fetchPack, state } = setup({ manifest: manifest(), stallMs: 200, autoResumeBaseMs: 60000 })
    await controller.sync({ force: true })
    fetchPack.mockImplementation(() => {
      state.online = false
      return new Promise(() => {})
    })
    await controller.startPictures('en')
    expect(controller.getSnapshot().languages.en.pictures).toMatchObject({ status: 'paused', reason: 'offline' })
  })

  it('does not pause a slow download that keeps making progress', async () => {
    const { controller, fetchPack } = setup({ manifest: manifest(), stallMs: 300 })
    await controller.sync({ force: true })
    fetchPack.mockImplementation(async (path, _signal, onChunk) => {
      for (let i = 0; i < 4; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 100))
        onChunk()
      }
      return okPack(path)
    })
    await controller.startPictures('en')
    expect(controller.getSnapshot().languages.en.pictures.status).toBe('complete')
  })
})

describe('Remove from this device and the update state', () => {
  it('keeps the section alive: server answer kept, device switch off, nothing downloads again', async () => {
    const { controller, state } = setup({ manifest: manifest() })
    await controller.sync({ force: true })
    await controller.removeAll()
    const snapshot = controller.getSnapshot()
    expect(snapshot.serverEnabled).toBe(true)
    expect(snapshot.prefs.enabled).toBe(false)
    expect(snapshot.languages).toEqual({})
    state.requests.length = 0
    await controller.setEnabled(true)
    expect(controller.getSnapshot().languages.en.meta).toBeTruthy()
  })

  it('marks a check that found nothing new as up to date', async () => {
    const { controller } = setup({ manifest: manifest() })
    await controller.sync({ force: true })
    expect(controller.getSnapshot().upToDateAt).toBeNull()
    await controller.sync({ force: true })
    expect(controller.getSnapshot().upToDateAt).toBeGreaterThan(0)
  })
})
