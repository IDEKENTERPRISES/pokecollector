import { describe, expect, it } from 'vitest'
import {
  legacySetsRedirect,
  parseSetsLanguage,
  resolveDefaultSetsLanguage,
  resolveSetsLanding,
  setsLanguagePath,
  setsSeriesPath,
  storedFilterLanguage,
  summariseLanguages,
} from './setsLanguage'

describe('setsLanguage paths', () => {
  it('builds language and series paths that cannot be a set id', () => {
    expect(setsLanguagePath('ja')).toBe('/sets/language/ja')
    expect(setsLanguagePath('zh-tw')).toBe('/sets/language/zh-tw')
    expect(setsSeriesPath('ja', 'sv')).toBe('/sets/language/ja/series/sv')
    expect(setsSeriesPath('en', 'a b')).toBe('/sets/language/en/series/a%20b')
  })
  it('parses only known languages', () => {
    expect(parseSetsLanguage('JA')).toBe('ja')
    expect(parseSetsLanguage('all')).toBeNull()
    expect(parseSetsLanguage('')).toBeNull()
    expect(parseSetsLanguage(undefined)).toBeNull()
  })
})

describe('resolveSetsLanding', () => {
  const base = { loading: false, codes: ['en', 'ja'], fallbackCode: 'en', defaultSetting: '' }
  it('waits while the languages load', () => {
    expect(resolveSetsLanding({ ...base, loading: true })).toEqual({ kind: 'loading' })
  })
  it('asks with two or more languages', () => {
    expect(resolveSetsLanding(base)).toEqual({ kind: 'select', codes: ['en', 'ja'] })
  })
  it('skips the choice with one language', () => {
    expect(resolveSetsLanding({ ...base, codes: ['ja'] })).toEqual({ kind: 'redirect', lang: 'ja' })
  })
  it('keeps the language step when the list is unavailable', () => {
    expect(resolveSetsLanding({ ...base, codes: [], fallbackCode: 'de' })).toEqual({ kind: 'select', codes: ['de'] })
    expect(resolveSetsLanding({ ...base, codes: [], defaultSetting: 'ja' })).toEqual({ kind: 'redirect', lang: 'ja' })
  })
  it('opens the default language when it is visible', () => {
    expect(resolveSetsLanding({ ...base, defaultSetting: 'ja' })).toEqual({ kind: 'redirect', lang: 'ja' })
  })
  it('falls back to choosing when the default is no longer visible', () => {
    expect(resolveSetsLanding({ ...base, defaultSetting: 'ko' })).toEqual({ kind: 'select', codes: ['en', 'ja'] })
    expect(resolveDefaultSetsLanguage('ko', ['en'])).toBeNull()
  })
})

describe('summariseLanguages', () => {
  it('counts sets, cards and owned cards per language', () => {
    const rows = summariseLanguages([
      { lang: 'en', total: 100, owned_count: 4 },
      { lang: 'en', total: 50, owned_count: 1 },
      { lang: 'ja', total: 70, owned_count: null },
    ], ['en', 'ja', 'de'])
    expect(rows).toEqual([
      { code: 'en', setCount: 2, total: 150, owned: 5, ownedKnown: true },
      { code: 'ja', setCount: 1, total: 70, owned: 0, ownedKnown: false },
      { code: 'de', setCount: 0, total: 0, owned: 0, ownedKnown: false },
    ])
  })
})

describe('legacySetsRedirect', () => {
  const visibleCodes = ['en', 'ja']
  it('sends /sets?lang=ja to the language', () => {
    expect(legacySetsRedirect({ pathname: '/sets', search: '?lang=ja&progress=started', visibleCodes }))
      .toBe('/sets/language/ja?progress=started')
  })
  it('leaves /sets alone without a language, and for lang=all', () => {
    expect(legacySetsRedirect({ pathname: '/sets', search: '', visibleCodes })).toBeNull()
    expect(legacySetsRedirect({ pathname: '/sets', search: '?lang=all', visibleCodes })).toBeNull()
  })
  it('moves an old series URL into its language', () => {
    expect(legacySetsRedirect({ pathname: '/sets/series/sv', search: '?lang=ja', visibleCodes }))
      .toBe('/sets/language/ja/series/sv')
    expect(legacySetsRedirect({ pathname: '/sets/series/sv', search: '', storedLang: 'ja', visibleCodes }))
      .toBe('/sets/language/ja/series/sv')
  })
  it('falls back to the landing when no language is usable', () => {
    expect(legacySetsRedirect({ pathname: '/sets/series/sv', search: '?lang=ko', visibleCodes })).toBe('/sets')
  })
})

describe('storedFilterLanguage', () => {
  it('reads the old langFilter', () => {
    expect(storedFilterLanguage('{"langFilter":"ja"}')).toBe('ja')
    expect(storedFilterLanguage({ langFilter: 'all' })).toBeNull()
    expect(storedFilterLanguage('not json')).toBeNull()
    expect(storedFilterLanguage('{}')).toBeNull()
  })
})
