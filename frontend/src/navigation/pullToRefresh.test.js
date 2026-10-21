import { describe, expect, it } from 'vitest'
import {
  PULL_DAMPING,
  PULL_MAX,
  PULL_THRESHOLD,
  canStartPull,
  pullDistance,
  pullReachedThreshold,
} from './pullToRefresh'

const target = matching => ({ closest: selector => (matching && selector.includes(matching) ? {} : null) })

describe('pullDistance', () => {
  it('is damped, never negative, and capped', () => {
    expect(pullDistance(0)).toBe(0)
    expect(pullDistance(-40)).toBe(0)
    expect(pullDistance(Number.NaN)).toBe(0)
    expect(pullDistance(100)).toBe(100 * PULL_DAMPING)
    expect(pullDistance(10_000)).toBe(PULL_MAX)
  })

  it('reaches the threshold only after a long enough pull', () => {
    expect(pullReachedThreshold(pullDistance(PULL_THRESHOLD / PULL_DAMPING - 2))).toBe(false)
    expect(pullReachedThreshold(pullDistance(PULL_THRESHOLD / PULL_DAMPING))).toBe(true)
  })
})

describe('canStartPull', () => {
  const base = { scrollY: 0, touchCount: 1, target: target(null), bodyOverflow: '' }

  it('starts only at the very top with one finger', () => {
    expect(canStartPull(base)).toBe(true)
    expect(canStartPull({ ...base, scrollY: 1 })).toBe(false)
    expect(canStartPull({ ...base, touchCount: 2 })).toBe(false)
    expect(canStartPull({ ...base, touchCount: 0 })).toBe(false)
  })

  it('does not start inside a sheet, a dialog, a menu or a text field', () => {
    for (const marker of ['[role="dialog"]', '[aria-modal="true"]', '[role="menu"]', 'textarea']) {
      expect(canStartPull({ ...base, target: target(marker) })).toBe(false)
    }
  })

  it('does not start while a sheet has locked the page scroll', () => {
    expect(canStartPull({ ...base, bodyOverflow: 'hidden' })).toBe(false)
  })
})
