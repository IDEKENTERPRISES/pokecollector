import { describe, expect, it } from 'vitest'
import {
  DAYS_KEY,
  TURN_KEY,
  factFor,
  isSplashEntry,
  localDate,
  readDay,
  splashLanguage,
  starterEntry,
  takeFactTurn,
  writeDay,
} from './entryStore.js'

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    values,
  }
}

const entry = (date, overrides = {}) => ({
  date,
  dex_id: 921,
  name: 'Pawmi',
  lang: 'en',
  generation: 9,
  region: 'Paldea',
  types: ['electric'],
  genus: 'Mouse Pokémon',
  height_m: 0.3,
  weight_kg: 2.5,
  shiny: false,
  facts: [
    { kind: 'signature-move', title: 'Nuzzle', text: 'A test fact.' },
    { kind: 'evolution', text: 'Another test fact.' },
  ],
  sprite_url: '/api/pokedex/images/showdown/921.gif',
  sprite_style: 'animated',
  ...overrides,
})

describe('localDate', () => {
  it('is the device date, also across month and year ends', () => {
    expect(localDate(0, new Date(2026, 9, 21, 23, 59))).toBe('2026-10-21')
    expect(localDate(1, new Date(2026, 9, 31, 12))).toBe('2026-11-01')
    expect(localDate(1, new Date(2026, 11, 31, 12))).toBe('2027-01-01')
    expect(localDate(-1, new Date(2026, 2, 1, 0, 5))).toBe('2026-02-28')
  })
})

describe('isSplashEntry', () => {
  it('accepts what the endpoint returns, without stats or facts too', () => {
    expect(isSplashEntry(entry('2026-10-21'))).toBe(true)
    expect(isSplashEntry(entry('2026-10-21', { weight_kg: null, height_m: null, facts: [] }))).toBe(true)
    expect(isSplashEntry(entry('2026-10-21', { sprite_url: '/api/pokedex/images/artwork-shiny/990.png', sprite_style: 'artwork' }))).toBe(true)
  })

  it('rejects anything that could point the sprite elsewhere or break the card', () => {
    for (const sprite_url of ['https://example.com/a.gif', '/api/pokedex/images/../x.gif', '//x/1.gif', '/api/x/1.gif', 'javascript:1']) {
      expect(isSplashEntry(entry('2026-10-21', { sprite_url })), sprite_url).toBe(false)
    }
    expect(isSplashEntry(entry('2026-10-21', { dex_id: 0 }))).toBe(false)
    expect(isSplashEntry(entry('2026-10-21', { name: '' }))).toBe(false)
    expect(isSplashEntry(entry('2026-10-21', { facts: [{ kind: 'move' }] }))).toBe(false)
    expect(isSplashEntry(entry('2026-10-21', { facts: 'fun' }))).toBe(false)
    expect(isSplashEntry(entry('2026-10-21', { sprite_style: 'hologram' }))).toBe(false)
    expect(isSplashEntry(entry('21.10.2026'))).toBe(false)
    expect(isSplashEntry(null)).toBe(false)
  })
})

describe('the starter', () => {
  it('is Pikachu with facts written for the app, in the app language', () => {
    const english = starterEntry('en', '2026-10-21')
    expect(english).toMatchObject({ date: '2026-10-21', dex_id: 25, name: 'Pikachu', weight_kg: 6, height_m: 0.4, starter: true })
    expect(isSplashEntry(english)).toBe(true)
    expect(english.facts[0]).toMatchObject({ kind: 'signature-move', title: 'Volt Tackle' })
    expect(starterEntry('de').facts[1].text).toContain('Donnerstein')
    expect(starterEntry('fr').lang).toBe('en')
  })
})

describe('the day store', () => {
  it('keeps today and the days ahead, by date', () => {
    const storage = memoryStorage()
    expect(readDay('2026-10-21', storage)).toBeNull()
    expect(writeDay(entry('2026-10-21'), storage, '2026-10-21')).toBe(true)
    expect(writeDay(entry('2026-10-22', { dex_id: 7, name: 'Squirtle' }), storage, '2026-10-21')).toBe(true)
    expect(readDay('2026-10-21', storage).name).toBe('Pawmi')
    expect(readDay('2026-10-22', storage).name).toBe('Squirtle')
    // The next day, yesterday's entry is dropped.
    writeDay(entry('2026-10-23'), storage, '2026-10-22')
    expect(Object.keys(JSON.parse(storage.values.get(DAYS_KEY)))).toEqual(['2026-10-22', '2026-10-23'])
  })

  it('ignores junk and entries filed under the wrong date', () => {
    expect(readDay('2026-10-21', memoryStorage({ [DAYS_KEY]: '{oops' }))).toBeNull()
    expect(readDay('2026-10-21', memoryStorage({ [DAYS_KEY]: JSON.stringify({ '2026-10-21': entry('2026-10-22') }) }))).toBeNull()
    expect(writeDay({ dex_id: 1 }, memoryStorage())).toBe(false)
  })
})

describe('facts in turn', () => {
  it('each launch shows the next fact of the day', () => {
    const storage = memoryStorage()
    const day = entry('2026-10-21')
    const shown = [0, 1, 2].map(() => factFor(day, takeFactTurn(storage)).text)
    expect(shown).toEqual(['A test fact.', 'Another test fact.', 'A test fact.'])
    expect(storage.values.get(TURN_KEY)).toBe('3')
    expect(factFor(entry('2026-10-21', { facts: [] }), 4)).toBeNull()
    expect(factFor(null, 0)).toBeNull()
  })
})

describe('splashLanguage', () => {
  it('asks the server for German or English', () => {
    expect(splashLanguage('de')).toBe('de')
    expect(splashLanguage('de-CH')).toBe('de')
    expect(splashLanguage('fr')).toBe('en')
    expect(splashLanguage(undefined)).toBe('en')
  })
})
