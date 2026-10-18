import { describe, expect, it } from 'vitest'
import de from './de.js'
import en from './en.js'

// P10 adds the push keys (pwa.push*) to both languages; until then neither has them.
const keys = object => Object.keys(object).sort()

describe('offline translations', () => {
  it('has the same sync keys in German and English', () => {
    expect(keys(de.sync)).toEqual(keys(en.sync))
    expect(keys(de.sync.state)).toEqual(keys(en.sync.state))
    expect(keys(de.sync.item)).toEqual(keys(en.sync.item))
  })

  it('has the same pwa keys in German and English', () => {
    expect(keys(de.pwa)).toEqual(keys(en.pwa))
  })

  it('has no empty strings', () => {
    for (const language of [en, de]) {
      for (const group of [language.sync, language.pwa, language.sync.state, language.sync.item]) {
        for (const [key, value] of Object.entries(group)) {
          if (typeof value === 'string') expect(value.trim(), key).not.toBe('')
        }
      }
    }
  })
})
