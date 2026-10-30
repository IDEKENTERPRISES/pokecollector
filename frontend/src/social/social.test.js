import { describe, expect, it } from 'vitest'
import { appIconNumber, isSocialEnabled } from './social'

describe('isSocialEnabled', () => {
  it('needs the admin switch and multi-user mode', () => {
    expect(isSocialEnabled({ social_features_enabled: 'true' }, true)).toBe(true)
    expect(isSocialEnabled({ social_features_enabled: 'true' }, false)).toBe(false)
    expect(isSocialEnabled({ social_features_enabled: 'false' }, true)).toBe(false)
    expect(isSocialEnabled({}, true)).toBe(false)
    expect(isSocialEnabled(undefined, true)).toBe(false)
  })
})

describe('appIconNumber', () => {
  it('adds the swap offers waiting only while social is on', () => {
    expect(appIconNumber(2, 3, true)).toBe(5)
    expect(appIconNumber(2, 3, false)).toBe(2)
    expect(appIconNumber(0, 0, true)).toBe(0)
    expect(appIconNumber(undefined, undefined, true)).toBe(0)
    expect(appIconNumber(-1, 'x', true)).toBe(0)
  })
})
