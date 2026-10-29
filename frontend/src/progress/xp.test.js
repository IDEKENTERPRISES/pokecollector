import { describe, expect, it } from 'vitest'
import { xpProgress } from './xp'

describe('xpProgress', () => {
  it('measures the XP earned inside the level against what the level is worth', () => {
    // Level 3 runs from 87 to 150 XP; 120 XP is 33 of 63 in.
    expect(xpProgress({ xp: 120, level: 3, level_start: 87, next_level_at: 150 })).toEqual({
      level: 3, into: 33, span: 63, remaining: 30, percent: 52, maxed: false,
    })
  })

  it('starts empty on the level boundary and is never past full', () => {
    expect(xpProgress({ xp: 50, level: 2, level_start: 50, next_level_at: 133 }).percent).toBe(0)
    expect(xpProgress({ xp: 500, level: 2, level_start: 50, next_level_at: 133 })).toMatchObject({ percent: 100, remaining: 0 })
    expect(xpProgress({ xp: 10, level: 2, level_start: 50, next_level_at: 133 })).toMatchObject({ into: 0, percent: 0 })
  })

  it('shows a full bar at the top level', () => {
    expect(xpProgress({ xp: 99999, level: 100, level_start: 49500, next_level_at: null })).toMatchObject({
      level: 100, percent: 100, maxed: true, remaining: 0,
    })
  })

  it('does not divide by zero on a degenerate level', () => {
    const progress = xpProgress({ xp: 5, level: 1, level_start: 5, next_level_at: 5 })
    expect(Number.isFinite(progress.percent)).toBe(true)
  })

  it('returns null without a level and tolerates missing numbers', () => {
    expect(xpProgress(undefined)).toBeNull()
    expect(xpProgress({})).toBeNull()
    expect(xpProgress({ level: 1, next_level_at: 50 })).toMatchObject({ into: 0, percent: 0, span: 50 })
  })
})
