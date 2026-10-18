import { describe, expect, it } from 'vitest'
import de from './de'
import en from './en'

describe('pwa translations', () => {
  it('German has exactly the English pwa keys', () => {
    expect(Object.keys(de.pwa).sort()).toEqual(Object.keys(en.pwa).sort())
  })

  it('includes the push keys', () => {
    for (const key of ['pushTitle', 'pushEnable', 'pushDisable', 'pushTest', 'pushDenied', 'pushIosHint']) {
      expect(typeof en.pwa[key]).toBe('string')
      expect(typeof de.pwa[key]).toBe('string')
    }
  })
})
