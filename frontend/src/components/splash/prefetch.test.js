import { describe, expect, it } from 'vitest'
import { DAYS_KEY, readDay } from './entryStore.js'
import { SPRITE_CACHE, cacheSprite, ensureDay, fetchDay, prefetchDays, spriteSource } from './prefetch.js'

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    values,
  }
}

const pathOf = url => new URL(typeof url === 'string' ? url : url.url, 'http://localhost').pathname

function fakeCaches() {
  const stores = new Map()
  const open = async name => {
    if (!stores.has(name)) stores.set(name, new Map())
    const store = stores.get(name)
    return {
      match: async url => store.get(pathOf(url))?.clone(),
      put: async (url, response) => { store.set(pathOf(url), response) },
      keys: async () => [...store.keys()].map(path => ({ url: `http://localhost${path}` })),
      delete: async request => store.delete(pathOf(request)),
    }
  }
  return {
    open,
    match: async (url, { cacheName }) => (stores.has(cacheName) ? (await open(cacheName)).match(url) : undefined),
    paths: name => [...(stores.get(name)?.keys() ?? [])].sort(),
  }
}

const NOW = new Date(2026, 9, 21, 9, 30)
const day = (date, dexId = 921) => ({
  date,
  dex_id: dexId,
  name: `Pokémon ${dexId}`,
  lang: 'en',
  generation: 9,
  region: 'Paldea',
  types: ['electric'],
  height_m: 0.3,
  weight_kg: 2.5,
  shiny: false,
  facts: [{ kind: 'trait', text: 'A test fact.' }],
  sprite_url: `/api/pokedex/images/showdown/${dexId}.gif`,
  sprite_style: 'animated',
})

const image = () => new Response(new Blob(['gif']), { headers: { 'Content-Type': 'image/gif' } })

function fakeFetch({ entries = { '2026-10-21': day('2026-10-21', 921), '2026-10-22': day('2026-10-22', 7) }, sprite = image, splash } = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    const parsed = new URL(url, 'http://localhost')
    if (parsed.pathname === '/api/pokedex/splash') {
      if (splash) return splash(parsed)
      const found = entries[parsed.searchParams.get('date')]
      return found ? Response.json(found) : new Response('{}', { status: 404 })
    }
    if (parsed.pathname.startsWith('/api/pokedex/images/')) return sprite(parsed.pathname)
    throw new Error(`unexpected ${url}`)
  }
  return { fetchImpl, calls }
}

describe('fetchDay', () => {
  it('asks for a date in the app language and checks the answer', async () => {
    const { fetchImpl, calls } = fakeFetch()
    expect(await fetchDay('2026-10-21', { language: 'de', fetchImpl })).toMatchObject({ dex_id: 921 })
    const request = new URL(calls[0].url, 'http://localhost')
    expect(Object.fromEntries(request.searchParams)).toEqual({ date: '2026-10-21', lang: 'de' })
    expect(calls[0].options).toMatchObject({ cache: 'no-store', credentials: 'same-origin' })
  })

  it('returns null for errors, junk, another date or no network', async () => {
    const cases = [
      fakeFetch({ splash: () => new Response('nope', { status: 503 }) }),
      fakeFetch({ splash: () => Response.json({ name: 'x' }) }),
      fakeFetch({ splash: () => Response.json(day('2026-10-20')) }),
      fakeFetch({ splash: () => { throw new TypeError('offline') } }),
    ]
    for (const { fetchImpl } of cases) expect(await fetchDay('2026-10-21', { fetchImpl })).toBeNull()
    expect(await fetchDay('2026-10-21', { fetchImpl: null })).toBeNull()
  })
})

describe('ensureDay', () => {
  it('uses the stored entry, else fetches, caches the sprite and stores it', async () => {
    const storage = memoryStorage()
    const cacheStorage = fakeCaches()
    const { fetchImpl, calls } = fakeFetch()
    const first = await ensureDay('2026-10-21', { fetchImpl, cacheStorage, storage, now: NOW })
    expect(first.dex_id).toBe(921)
    expect(readDay('2026-10-21', storage).dex_id).toBe(921)
    expect(cacheStorage.paths(SPRITE_CACHE)).toEqual(['/api/pokedex/images/showdown/921.gif'])
    const callsBefore = calls.length
    expect((await ensureDay('2026-10-21', { fetchImpl, cacheStorage, storage, now: NOW })).dex_id).toBe(921)
    expect(calls.length).toBe(callsBefore)
  })

  it('fetches again after the app language changed, keeping the old entry if that fails', async () => {
    const storage = memoryStorage()
    await ensureDay('2026-10-21', { fetchImpl: fakeFetch().fetchImpl, cacheStorage: fakeCaches(), storage, now: NOW })
    const offline = fakeFetch({ splash: () => { throw new TypeError('offline') } })
    expect((await ensureDay('2026-10-21', { language: 'de', fetchImpl: offline.fetchImpl, storage, now: NOW })).lang).toBe('en')
  })

  it('does not store an entry whose sprite cannot be fetched', async () => {
    const storage = memoryStorage()
    const { fetchImpl } = fakeFetch({ sprite: () => new Response('missing', { status: 404 }) })
    expect(await ensureDay('2026-10-21', { fetchImpl, cacheStorage: fakeCaches(), storage, now: NOW })).toBeNull()
    expect(storage.values.has(DAYS_KEY)).toBe(false)
  })
})

describe('prefetchDays', () => {
  it('stores today and tomorrow, and keeps only their sprites and the starter', async () => {
    const storage = memoryStorage()
    const cacheStorage = fakeCaches()
    await (await cacheStorage.open(SPRITE_CACHE)).put('/api/pokedex/images/showdown/150.gif', image())
    expect(await prefetchDays({ fetchImpl: fakeFetch().fetchImpl, cacheStorage, storage, now: NOW })).toBe('stored')
    expect(readDay('2026-10-22', storage).dex_id).toBe(7)
    expect(cacheStorage.paths(SPRITE_CACHE)).toEqual([
      '/api/pokedex/images/showdown/25.gif',
      '/api/pokedex/images/showdown/7.gif',
      '/api/pokedex/images/showdown/921.gif',
    ])
  })

  it('works without Cache Storage, and reports a failure', async () => {
    expect(await prefetchDays({ fetchImpl: fakeFetch().fetchImpl, cacheStorage: undefined, storage: memoryStorage(), now: NOW })).toBe('stored')
    const down = fakeFetch({ splash: () => new Response('', { status: 503 }) })
    expect(await prefetchDays({ fetchImpl: down.fetchImpl, cacheStorage: fakeCaches(), storage: memoryStorage(), now: NOW })).toBe('failed')
    expect(await prefetchDays({ fetchImpl: null, storage: memoryStorage() })).toBe('skipped')
  })
})

describe('sprites', () => {
  it('cacheSprite accepts images only', async () => {
    const cacheStorage = fakeCaches()
    const html = fakeFetch({ sprite: () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }) })
    expect(await cacheSprite('/api/pokedex/images/showdown/1.gif', { fetchImpl: html.fetchImpl, cacheStorage })).toBe(false)
    expect(await cacheSprite('/api/pokedex/images/showdown/1.gif', { fetchImpl: fakeFetch().fetchImpl, cacheStorage })).toBe(true)
  })

  it('spriteSource serves a cached sprite as a blob URL, else the server URL', async () => {
    const cacheStorage = fakeCaches()
    const entry = day('2026-10-21')
    expect(await spriteSource(entry, { cacheStorage })).toBe(entry.sprite_url)
    await (await cacheStorage.open(SPRITE_CACHE)).put(entry.sprite_url, image())
    const source = await spriteSource(entry, { cacheStorage })
    expect(source.startsWith('blob:')).toBe(true)
    URL.revokeObjectURL(source)
    expect(await spriteSource({}, { cacheStorage })).toBeNull()
  })
})
