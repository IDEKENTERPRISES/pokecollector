import { describe, expect, it } from 'vitest'
import { shouldDismiss } from './PageSheet'

describe('shouldDismiss', () => {
  it('dismisses past min(160 px, a quarter of the height)', () => {
    expect(shouldDismiss({ dy: 161, velocity: 0, height: 800 })).toBe(true)
    expect(shouldDismiss({ dy: 160, velocity: 0, height: 800 })).toBe(false)
    // A short sheet: a quarter of 400 is 100
    expect(shouldDismiss({ dy: 101, velocity: 0, height: 400 })).toBe(true)
    expect(shouldDismiss({ dy: 100, velocity: 0, height: 400 })).toBe(false)
  })

  it('dismisses a flick faster than 0.6 px/ms that moved more than 24 px', () => {
    expect(shouldDismiss({ dy: 30, velocity: 0.61, height: 800 })).toBe(true)
    expect(shouldDismiss({ dy: 25, velocity: 1.5, height: 800 })).toBe(true)
  })

  it('springs back a slow or tiny drag', () => {
    expect(shouldDismiss({ dy: 30, velocity: 0.6, height: 800 })).toBe(false)
    expect(shouldDismiss({ dy: 24, velocity: 2, height: 800 })).toBe(false)
    expect(shouldDismiss({ dy: 80, velocity: 0.2, height: 800 })).toBe(false)
  })

  it('never dismisses an upward or zero drag', () => {
    expect(shouldDismiss({ dy: 0, velocity: 5, height: 800 })).toBe(false)
    expect(shouldDismiss({ dy: -50, velocity: 5, height: 800 })).toBe(false)
  })

  it('copes with a missing height', () => {
    expect(shouldDismiss({ dy: 10 })).toBe(true)
    expect(shouldDismiss({ dy: 0 })).toBe(false)
  })
})
