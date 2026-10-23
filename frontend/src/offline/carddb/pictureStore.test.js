import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { PICTURE_DB_NAME, createPictureStore } from './pictureStore.js'

const text = async blob => new TextDecoder().decode(await blob.arrayBuffer())
const pack = { lang: 'en', setId: 'sv1', blob: new Blob(['AAbbbCC']), items: [
  { id: 'sv1-1', offset: 2, length: 3, type: 'image/webp' },
  { id: 'sv1-2', offset: 5, length: 2, type: 'image/png' },
] }

describe('picture store', () => {
  it('returns each picture as a slice of its set pack, with its type', async () => {
    const store = createPictureStore({ indexedDB: new IDBFactory() })
    await store.putPack(pack)
    const one = await store.getCard('sv1-1')
    expect(one.type).toBe('image/webp')
    expect(await text(one)).toBe('bbb')
    expect(await text(await store.getCard('sv1-2'))).toBe('CC')
    expect(await store.getCard('nope')).toBeNull()
  })

  it('keeps loose pictures under their path and lists every stored path', async () => {
    const store = createPictureStore({ indexedDB: new IDBFactory() })
    await store.putPack(pack)
    await store.putLoose({ lang: 'en', path: '/api/images/set/sv1/logo', blob: new Blob(['L']), type: 'image/png' })
    expect(await text(await store.getLoose('/api/images/set/sv1/logo'))).toBe('L')
    expect(await store.getLoose('/x')).toBeNull()
    const paths = await store.knownPaths(id => `/api/images/card/${id}/small`)
    expect([...paths].sort()).toEqual(['/api/images/card/sv1-1/small', '/api/images/card/sv1-2/small', '/api/images/set/sv1/logo'])
    expect(await store.count('en')).toBe(3)
  })

  it('deletes one language and keeps the others, or everything', async () => {
    const store = createPictureStore({ indexedDB: new IDBFactory() })
    await store.putPack(pack)
    await store.putPack({ lang: 'de', setId: 'sv1', blob: new Blob(['zz']), items: [{ id: 'sv1-1_de', offset: 0, length: 2, type: 'image/webp' }] })
    await store.putLoose({ lang: 'en', path: '/p', blob: new Blob(['L']), type: 'image/png' })
    await store.deleteLanguage('en')
    expect(await store.count('en')).toBe(0)
    expect(await store.getCard('sv1-1')).toBeNull()
    expect(await store.getLoose('/p')).toBeNull()
    expect(await text(await store.getCard('sv1-1_de'))).toBe('zz')
    await store.clearAll()
    expect(await store.count('de')).toBe(0)
  })

  it('stores thousands of pictures as a handful of blobs', async () => {
    const indexedDB = new IDBFactory()
    const store = createPictureStore({ indexedDB })
    const items = Array.from({ length: 3000 }, (_, i) => ({ id: `c-${i}`, offset: i * 2, length: 2, type: 'image/webp' }))
    await store.putPack({ lang: 'en', setId: 'big', blob: new Blob([new Uint8Array(6000)]), items })
    expect((await store.getCard('c-2999')).size).toBe(2)
    expect(await store.count('en')).toBe(3000)
    expect((await indexedDB.databases()).map(db => db.name)).toEqual([PICTURE_DB_NAME])
  })

  it('rejects when IndexedDB is missing, so the caller can report "storage"', async () => {
    await expect(createPictureStore({ indexedDB: null }).knownPaths(String)).rejects.toThrow()
  })
})
