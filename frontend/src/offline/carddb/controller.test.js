import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PREFS_KEY, SYNC_THROTTLE_MS, createCardDbController, createFetchJson, readPrefs, wantedLanguages } from './controller.js'
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

const imageResponse = () => ({ status: 200, headers: { get: () => 'image/webp' } })

function setup({ manifest, online = true } = {}) {
  const store = createCardDbStore(new IDBFactory())
  const storage = memoryStorage()
  const cacheApi = fakeCaches()
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
  const controller = createCardDbController({
    store,
    fetchJson,
    fetchImage,
    openCache: cacheApi.open,
    deleteCache: cacheApi.remove,
    listCaches: cacheApi.keys,
    storage,
    isOnline: () => state.online,
    requestPersist: vi.fn(async () => true),
    now: () => state.now ?? Date.now(),
  })
  return { controller, store, storage, state, cacheApi, fetchImage }
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

  it('downloads into a separate cache per language, resumes without refetching, and removes cleanly', async () => {
    const { controller, cacheApi, fetchImage } = setup({ manifest: manifest() })
    await controller.sync({ force: true })
    await controller.startPictures('en')
    expect(controller.getSnapshot().languages.en.pictures).toMatchObject({ status: 'complete', done: 6, total: 6 })
    expect(cacheApi.caches.has(pictureCacheName('en'))).toBe(true)
    expect(controller.getSnapshot().prefs.pictures.en).toBe(true)
    const calls = fetchImage.mock.calls.length
    await controller.startPictures('en')
    expect(fetchImage.mock.calls.length).toBe(calls) // everything cached already
    await controller.removePictures('en')
    expect(cacheApi.caches.has(pictureCacheName('en'))).toBe(false)
    expect(controller.getSnapshot().languages.en.pictures.status).toBe('none')
  })

  it('pauses on abort and keeps what was downloaded', async () => {
    const { controller, fetchImage, cacheApi } = setup({ manifest: manifest() })
    await controller.sync({ force: true })
    let count = 0
    fetchImage.mockImplementation(async () => {
      count += 1
      if (count === 2) controller.pausePictures('en')
      return imageResponse()
    })
    await controller.startPictures('en')
    expect(controller.getSnapshot().languages.en.pictures.status).toBe('paused')
    expect(cacheApi.caches.get(pictureCacheName('en')).size).toBeGreaterThan(0)
    expect(cacheApi.caches.get(pictureCacheName('en')).size).toBeLessThan(6)
  })

  it('removing everything also deletes the picture caches', async () => {
    const { controller, cacheApi } = setup({ manifest: manifest() })
    await controller.sync({ force: true })
    await controller.startPictures('de')
    await controller.removeAll()
    expect(cacheApi.caches.size).toBe(0)
  })
})
