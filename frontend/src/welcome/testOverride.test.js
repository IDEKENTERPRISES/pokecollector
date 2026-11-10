import { describe, expect, it } from 'vitest'
import { planWhatsNew, releases } from './releases'
import { takeTestOverride, testChoices, testKey, writeTestOverride } from './testOverride'

const memory = () => {
  const data = {}
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v) }, removeItem: (k) => { delete data[k] }, data }
}

describe('the nonprod "Test What\'s new" override', () => {
  it('offers every past release but the running one, then "before the first release"', () => {
    const names = releases().map((r) => r.name)
    const choices = testChoices()
    expect(choices.map((c) => c.name)).toEqual([...names.slice(1), names.at(-1)])
    expect(choices.map((c) => !!c.before)).toEqual([...names.slice(1).map(() => false), true])
  })

  it('each choice opens the sheet with exactly the newer releases', () => {
    const missed = (choice) => planWhatsNew({ serverSeen: choice.seen, localSeen: choice.seen }).missed.map((r) => r.name)
    const names = releases().map((r) => r.name)
    // Choice i is "as if I last had release i + 1" (the last one: a build before the first release).
    testChoices().forEach((choice, i) => expect(missed(choice)).toEqual(names.slice(0, i + 1)))
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
