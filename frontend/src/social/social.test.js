import { describe, expect, it } from 'vitest'
import { isSocialEnabled } from './social'

describe('isSocialEnabled', () => {
  it('needs the admin switch and multi-user mode', () => {
    expect(isSocialEnabled({ social_features_enabled: 'true' }, true)).toBe(true)
    expect(isSocialEnabled({ social_features_enabled: 'true' }, false)).toBe(false)
    expect(isSocialEnabled({ social_features_enabled: 'false' }, true)).toBe(false)
    expect(isSocialEnabled({}, true)).toBe(false)
    expect(isSocialEnabled(undefined, true)).toBe(false)
  })
})
