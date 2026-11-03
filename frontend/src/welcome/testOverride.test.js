import { describe, expect, it } from 'vitest'
import { planWhatsNew } from './releases'
import { takeTestOverride, testChoices, testKey, writeTestOverride } from './testOverride'

const memory = () => {
  const data = {}
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v) }, removeItem: (k) => { delete data[k] }, data }
}

describe('the nonprod "Test What\'s new" override', () => {
  it('offers every past release but the running one, then "before the first release"', () => {
    const choices = testChoices()
    expect(choices.map((c) => c.name)).toEqual(['Squirtle', 'Charmander', 'Bulbasaur', 'Bulbasaur'])
    expect(choices.map((c) => !!c.before)).toEqual([false, false, false, true])
  })

  it('each choice opens the sheet with exactly the newer releases', () => {
    const missed = (choice) => planWhatsNew({ serverSeen: choice.seen, localSeen: choice.seen }).missed.map((r) => r.name)
    const [squirtle, charmander, bulbasaur, before] = testChoices()
    expect(missed(squirtle)).toEqual(['Chikorita'])
    expect(missed(charmander)).toEqual(['Chikorita', 'Squirtle'])
    expect(missed(bulbasaur)).toEqual(['Chikorita', 'Squirtle', 'Charmander'])
    expect(missed(before)).toEqual(['Chikorita', 'Squirtle', 'Charmander', 'Bulbasaur'])
  })

  it('is read once and cleared', () => {
    const storage = memory()
    writeTestOverride(7, '2026-10-29', storage)
    expect(storage.data[testKey(7)]).toBe('2026-10-29')
    expect(takeTestOverride(7, storage)).toBe('2026-10-29')
    expect(takeTestOverride(7, storage)).toBeNull()
  })

  it('never throws when storage is blocked', () => {
    const blocked = { getItem() { throw new Error('no') }, setItem() { throw new Error('no') }, removeItem() { throw new Error('no') } }
    expect(takeTestOverride(7, blocked)).toBeNull()
    expect(() => writeTestOverride(7, 'x', blocked)).not.toThrow()
  })
})
