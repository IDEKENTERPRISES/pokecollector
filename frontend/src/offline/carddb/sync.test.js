import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { createCardDbStore } from './store.js'
import {
  AbortedError,
  MANIFEST_PATH,
  OfflineError,
  planSync,
  pricesPath,
  runCardDbSync,
  setPath,
  syncLanguage,
} from './sync.js'

const entry = (id, hash, bytes = 100) => ({ id, hash, cards: 2, bytes })
const remoteFor = (sets, extra = {}) => ({ hash: 'L1', prices_hash: 'P1', prices_bytes: 50, prices_updated_at: '2026-10-22', card_count: 4, sets, ...extra })

function fakeServer(initial) {
  const state = { manifest: initial, requests: [], offline: false, failAt: null }
  const payloads = {}
  const fetchJson = async (path) => {
    state.requests.push(path)
    if (state.offline) throw new Error('Network Error')
    if (state.failAt === path) throw new Error('Network Error')
    if (path === MANIFEST_PATH) return { status: state.manifest ? 200 : 404, data: state.manifest }
    if (path.includes('/prices/')) return { status: 200, etag: state.pricesEtag, data: { fields: ['price_market'], rows: [['a_en', 1]] } }
    const setId = decodeURIComponent(path.split('/').pop())
    if (payloads[setId] === null) return { status: 404 }
    return { status: 200, data: { v: 1, set: { id: setId }, fields: ['id'], cards: [['x'], ['y']] } }
  }
  return { state, fetchJson, payloads }
}

let store
beforeEach(() => { store = createCardDbStore(new IDBFactory()) })

describe('planSync', () => {
  it('fetches new and changed sets, removes the ones the server dropped, and updates prices only when their hash differs', () => {
    const plan = planSync(
      remoteFor([entry('a', 'h1'), entry('b', 'h2new'), entry('c', 'h3')]),
      { setHashes: new Map([['a', 'h1'], ['b', 'h2'], ['gone', 'h9']]), pricesHash: 'P1' },
    )
    expect(plan.fetchSets.map(e => e.id)).toEqual(['b', 'c'])
    expect(plan.removeSets).toEqual(['gone'])
    expect(plan.fetchPrices).toBe(false)
    expect(plan.upToDate).toBe(false)
  })
  it('is up to date when every hash matches', () => {
    const plan = planSync(remoteFor([entry('a', 'h1')]), { setHashes: new Map([['a', 'h1']]), pricesHash: 'P1' })
    expect(plan.upToDate).toBe(true)
  })
  it('fetches prices on their own when only the prices hash changed', () => {
    const plan = planSync(remoteFor([entry('a', 'h1')], { prices_hash: 'P2' }), { setHashes: new Map([['a', 'h1']]), pricesHash: 'P1' })
    expect(plan.fetchSets).toEqual([])
    expect(plan.fetchPrices).toBe(true)
  })
})

describe('runCardDbSync', () => {
  const manifestWith = sets => ({ languages: { en: remoteFor(sets) } })

  it('downloads everything on the first run, and nothing on the second when the manifest is unchanged', async () => {
    const server = fakeServer(manifestWith([entry('a', 'h1'), entry('b', 'h2')]))
    const first = await runCardDbSync({ wantedLanguages: ['en'], store, fetchJson: server.fetchJson })
    expect(first.languages[0]).toMatchObject({ lang: 'en', fetchedSets: 2, fetchedPrices: true })
    expect(await store.listSetHashes('en')).toEqual(new Map([['a', 'h1'], ['b', 'h2']]))
    expect((await store.getPrices('en')).rows).toEqual([['a_en', 1]])
    expect(await store.getMeta('en')).toMatchObject({ hash: 'L1', pricesHash: 'P1' })

    server.state.requests.length = 0
    const second = await runCardDbSync({ wantedLanguages: ['en'], store, fetchJson: server.fetchJson })
    expect(second.languages[0].upToDate).toBe(true)
    expect(server.state.requests).toEqual([MANIFEST_PATH])
  })

  it('fetches only the changed set and replaces the removed one', async () => {
    const server = fakeServer(manifestWith([entry('a', 'h1'), entry('b', 'h2')]))
    await runCardDbSync({ wantedLanguages: ['en'], store, fetchJson: server.fetchJson })
    server.state.manifest = { languages: { en: remoteFor([entry('a', 'h1'), entry('c', 'h3')], { hash: 'L2' }) } }
    server.state.requests.length = 0
    await runCardDbSync({ wantedLanguages: ['en'], store, fetchJson: server.fetchJson })
    expect(server.state.requests).toEqual([MANIFEST_PATH, setPath('en', 'c')])
    expect(await store.listSetHashes('en')).toEqual(new Map([['a', 'h1'], ['c', 'h3']]))
    expect(await store.getSet('en', 'b')).toBeNull()
  })

  it('updates prices alone when only the prices hash changed', async () => {
    const server = fakeServer(manifestWith([entry('a', 'h1')]))
    await runCardDbSync({ wantedLanguages: ['en'], store, fetchJson: server.fetchJson })
    server.state.manifest = { languages: { en: remoteFor([entry('a', 'h1')], { prices_hash: 'P2' }) } }
    server.state.requests.length = 0
    await runCardDbSync({ wantedLanguages: ['en'], store, fetchJson: server.fetchJson })
    expect(server.state.requests).toEqual([MANIFEST_PATH, pricesPath('en')])
    expect((await store.getMeta('en')).pricesHash).toBe('P2')
  })

  it('resumes after an interruption: finished sets are not fetched again', async () => {
    const server = fakeServer(manifestWith([entry('a', 'h1'), entry('b', 'h2'), entry('c', 'h3')]))
    server.state.failAt = setPath('en', 'c')
    await expect(runCardDbSync({ wantedLanguages: ['en'], store, fetchJson: server.fetchJson, concurrency: 1 })).rejects.toBeInstanceOf(OfflineError)
    expect((await store.listSetHashes('en')).size).toBe(2)
    expect(await store.getMeta('en')).toBeNull() // a half-finished run is not marked complete

    server.state.failAt = null
    server.state.requests.length = 0
    await runCardDbSync({ wantedLanguages: ['en'], store, fetchJson: server.fetchJson, concurrency: 1 })
    expect(server.state.requests).toEqual([MANIFEST_PATH, setPath('en', 'c'), pricesPath('en')])
    expect(await store.getMeta('en')).toMatchObject({ hash: 'L1' })
  })

  it('stops with OfflineError when the network is gone and keeps what it has', async () => {
    const server = fakeServer(manifestWith([entry('a', 'h1')]))
    server.state.offline = true
    await expect(runCardDbSync({ wantedLanguages: ['en'], store, fetchJson: server.fetchJson })).rejects.toBeInstanceOf(OfflineError)
  })

  it('stops with AbortedError when cancelled', async () => {
    const server = fakeServer(manifestWith([entry('a', 'h1'), entry('b', 'h2')]))
    const controller = new AbortController()
    controller.abort()
    await expect(syncLanguage({
      lang: 'en', remote: remoteFor([entry('a', 'h1')]), store, fetchJson: server.fetchJson, signal: controller.signal,
    })).rejects.toBeInstanceOf(AbortedError)
  })

  it('removes a language that was switched off or is no longer synced by the server', async () => {
    const server = fakeServer({ languages: { en: remoteFor([entry('a', 'h1')]), de: remoteFor([entry('a', 'd1')]) } })
    await runCardDbSync({ wantedLanguages: ['en', 'de'], store, fetchJson: server.fetchJson })
    expect((await store.listLanguages()).sort()).toEqual(['de', 'en'])
    await runCardDbSync({ wantedLanguages: ['en'], store, fetchJson: server.fetchJson })
    expect(await store.listLanguages()).toEqual(['en'])
    expect((await store.listSetHashes('de')).size).toBe(0)
  })

  it('reports disabled and clears local data when the server turns the feature off', async () => {
    const server = fakeServer(manifestWith([entry('a', 'h1')]))
    await runCardDbSync({ wantedLanguages: ['en'], store, fetchJson: server.fetchJson })
    server.state.manifest = null
    const result = await runCardDbSync({ wantedLanguages: ['en'], store, fetchJson: server.fetchJson })
    expect(result.status).toBe('disabled')
    expect(await store.listLanguages()).toEqual([])
  })

  it('treats a storage failure as "off": the run fails instead of pretending it saved', async () => {
    const brokenStore = { ...createCardDbStore(new IDBFactory()), putSet: async () => false }
    const server = fakeServer(manifestWith([entry('a', 'h1')]))
    await expect(runCardDbSync({ wantedLanguages: ['en'], store: brokenStore, fetchJson: server.fetchJson })).rejects.toBeInstanceOf(OfflineError)
  })
})

describe('store', () => {
  it('reports unavailable and returns fallbacks when IndexedDB is missing', async () => {
    const none = createCardDbStore(null)
    expect(await none.available()).toBe(false)
    expect(await none.getMeta('en')).toBeNull()
    expect((await none.listSetHashes('en')).size).toBe(0)
    expect(await none.putSet('en', 'a', { hash: 'h', payload: {} })).toBe(false)
  })

  it('keeps languages apart and sums the bytes', async () => {
    await store.putSet('en', 'a', { hash: 'h1', bytes: 10, payload: { cards: [] } })
    await store.putSet('de', 'a', { hash: 'd1', bytes: 5, payload: { cards: [] } })
    expect((await store.listSetHashes('en')).get('a')).toBe('h1')
    expect(await store.usage('en')).toBe(10)
    await store.deleteLanguage('en')
    expect((await store.listSetHashes('en')).size).toBe(0)
    expect((await store.listSetHashes('de')).get('a')).toBe('d1')
  })
})
