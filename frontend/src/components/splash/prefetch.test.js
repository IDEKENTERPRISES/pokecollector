import { describe, expect, it } from 'vitest'
import { NEXT_KEY, SEEN_KEY, readNextEntry } from './entryStore.js'
import { SPRITE_CACHE, prefetchNextEntry, spriteSource } from './prefetch.js'
import { encodeSeen } from './shuffleBag.js'

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
    paths: name => [...(stores.get(name)?.keys() ?? [])],
  }
}

const entry = {
  dex_id: 921,
  name: 'Pawmi',
  lang: 'en',
  generation: 9,
  region: 'Paldea',
  types: ['electric'],
  weight_kg: 2.5,
  fact: 'A fact.',
  sprite_url: '/api/pokedex/images/sprites/921.png',
}

const image = () => new Response(new Blob(['png']), { headers: { 'Content-Type': 'image/png' } })

function fakeFetch({ splash = () => Response.json(entry), sprite = image } = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (url.startsWith('/api/pokedex/splash')) return splash()
    if (url.startsWith('/api/pokedex/images/')) return sprite(url)
    throw new Error(`unexpected ${url}`)
  }
  return { fetchImpl, calls }
}

describe('prefetchNextEntry', () => {
  it('stores the next entry once its sprite and the starter sprite are cached', async () => {
    const storage = memoryStorage({ [SEEN_KEY]: encodeSeen([25]) })
    const cacheStorage = fakeCaches()
    const { fetchImpl, calls } = fakeFetch()

    expect(await prefetchNextEntry({ language: 'de', fetchImpl, cacheStorage, storage })).toBe('stored')

    const request = new URL(calls[0].url, 'http://localhost')
    expect(request.pathname).toBe('/api/pokedex/splash')
    expect(request.searchParams.get('lang')).toBe('de')
    expect(request.searchParams.get('seen')).toBe(encodeSeen([25]))
    expect(calls[0].options).toMatchObject({ cache: 'no-store', credentials: 'same-origin' })
    expect(readNextEntry(storage)).toMatchObject({ dex_id: 921, name: 'Pawmi' })
    expect(cacheStorage.paths(SPRITE_CACHE).sort()).toEqual([
      '/api/pokedex/images/animated/25.gif',
      '/api/pokedex/images/sprites/921.png',
    ])
  })

  it('keeps only the next sprite and the starter, never a growing pile', async () => {
    const storage = memoryStorage()
    const cacheStorage = fakeCaches()
    const old = await cacheStorage.open(SPRITE_CACHE)
    await old.put('/api/pokedex/images/animated/7.gif', image())
    await prefetchNextEntry({ fetchImpl: fakeFetch().fetchImpl, cacheStorage, storage })
    expect(cacheStorage.paths(SPRITE_CACHE)).not.toContain('/api/pokedex/images/animated/7.gif')
    expect(cacheStorage.paths(SPRITE_CACHE)).toHaveLength(2)
  })

  it('omits an empty bag and works without Cache Storage', async () => {
    const storage = memoryStorage()
    const { fetchImpl, calls } = fakeFetch()
    expect(await prefetchNextEntry({ fetchImpl, cacheStorage: undefined, storage })).toBe('stored')
    expect(new URL(calls[0].url, 'http://localhost').searchParams.has('seen')).toBe(false)
  })

  it('keeps the previous entry when the server, the payload or the sprite fails', async () => {
    const previous = JSON.stringify({ ...entry, dex_id: 7, name: 'Squirtle', sprite_url: '/api/pokedex/images/animated/7.gif' })
    const cases = [
      fakeFetch({ splash: () => new Response('nope', { status: 503 }) }),
      fakeFetch({ splash: () => Response.json({ ...entry, sprite_url: 'https://example.com/x.png' }) }),
      fakeFetch({ sprite: () => new Response('missing', { status: 404 }) }),
      fakeFetch({ sprite: () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } }) }),
      fakeFetch({ splash: () => { throw new TypeError('offline') } }),
    ]
    for (const { fetchImpl } of cases) {
      const storage = memoryStorage({ [NEXT_KEY]: previous })
      expect(await prefetchNextEntry({ fetchImpl, cacheStorage: fakeCaches(), storage })).toBe('failed')
      expect(readNextEntry(storage).name).toBe('Squirtle')
    }
  })

  it('does nothing without fetch', async () => {
    expect(await prefetchNextEntry({ fetchImpl: null, storage: memoryStorage() })).toBe('skipped')
  })
})

describe('spriteSource', () => {
  it('serves a cached sprite as a blob URL, so it shows offline', async () => {
    const cacheStorage = fakeCaches()
    await (await cacheStorage.open(SPRITE_CACHE)).put(entry.sprite_url, image())
    const source = await spriteSource(entry, { cacheStorage })
    expect(source.startsWith('blob:')).toBe(true)
    URL.revokeObjectURL(source)
  })

  it('falls back to the server URL', async () => {
    expect(await spriteSource(entry, { cacheStorage: fakeCaches() })).toBe(entry.sprite_url)
    expect(await spriteSource(entry, { cacheStorage: undefined })).toBe(entry.sprite_url)
    expect(await spriteSource({}, { cacheStorage: undefined })).toBeNull()
  })
})
