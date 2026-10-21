import { describe, expect, it } from 'vitest'
import {
  NEXT_KEY,
  SEEN_KEY,
  isSplashEntry,
  markShown,
  pickLaunchEntry,
  readNextEntry,
  readSeen,
  starterEntry,
  writeNextEntry,
} from './entryStore.js'
import { decodeSeen } from './shuffleBag.js'

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    values,
  }
}

const pawmi = {
  dex_id: 921,
  name: 'Pawmi',
  lang: 'en',
  generation: 9,
  region: 'Paldea',
  types: ['electric'],
  weight_kg: 2.5,
  height_m: 0.3,
  genus: 'Mouse Pokémon',
  fact: 'A fact.',
  sprite_url: '/api/pokedex/images/sprites/921.png',
}

describe('isSplashEntry', () => {
  it('accepts what the endpoint returns, without a weight too', () => {
    expect(isSplashEntry(pawmi)).toBe(true)
    expect(isSplashEntry({ ...pawmi, weight_kg: null, fact: null })).toBe(true)
  })

  it('rejects anything that could point the sprite elsewhere or break the card', () => {
    for (const sprite_url of ['https://example.com/a.gif', '/api/pokedex/images/../x.gif', '//x/1.gif', '/api/x/1.gif', 'javascript:1']) {
      expect(isSplashEntry({ ...pawmi, sprite_url }), sprite_url).toBe(false)
    }
    expect(isSplashEntry({ ...pawmi, dex_id: 0 })).toBe(false)
    expect(isSplashEntry({ ...pawmi, dex_id: 1026 })).toBe(false)
    expect(isSplashEntry({ ...pawmi, name: '' })).toBe(false)
    expect(isSplashEntry({ ...pawmi, weight_kg: -1 })).toBe(false)
    expect(isSplashEntry(null)).toBe(false)
    expect(isSplashEntry('Pawmi')).toBe(false)
  })
})

describe('the starter', () => {
  it('is Pikachu with a fact built from data, in the app language', () => {
    const english = starterEntry('en')
    expect(english).toMatchObject({ dex_id: 25, name: 'Pikachu', generation: 1, region: 'Kanto', weight_kg: 6, starter: true })
    expect(isSplashEntry(english)).toBe(true)
    expect(starterEntry('de').fact).toContain('Elektro')
    expect(starterEntry('fr').lang).toBe('en')
  })
})

describe('the picker', () => {
  it('shows the prefetched entry when there is a valid one, else the starter', () => {
    expect(pickLaunchEntry({ next: pawmi })).toBe(pawmi)
    expect(pickLaunchEntry({ next: null, language: 'de' })).toMatchObject({ dex_id: 25, lang: 'de' })
    expect(pickLaunchEntry({ next: { ...pawmi, sprite_url: 'https://x/1.gif' } }).dex_id).toBe(25)
    expect(pickLaunchEntry().dex_id).toBe(25)
  })
})

describe('the stored entry', () => {
  it('round-trips through localStorage and ignores junk', () => {
    const storage = memoryStorage()
    expect(readNextEntry(storage)).toBeNull()
    expect(writeNextEntry(pawmi, storage)).toBe(true)
    expect(readNextEntry(storage)).toEqual(pawmi)
    expect(writeNextEntry({ dex_id: 1 }, storage)).toBe(false)
    expect(readNextEntry(memoryStorage({ [NEXT_KEY]: '{oops' }))).toBeNull()
    expect(readNextEntry(memoryStorage({ [NEXT_KEY]: '{"dex_id": 5}' }))).toBeNull()
  })

  it('puts shown species in the shuffle bag', () => {
    const storage = memoryStorage()
    markShown(25, storage)
    markShown(921, storage)
    expect(decodeSeen(storage.values.get(SEEN_KEY))).toEqual(new Set([25, 921]))
    expect(decodeSeen(readSeen(storage))).toEqual(new Set([25, 921]))
  })
})
