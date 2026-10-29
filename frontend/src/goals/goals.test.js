import { describe, expect, it } from 'vitest'
import { goalPercent, isGoalComplete, pinnedGoals, setGoalParams, wholePercent } from './goals'

describe('goals helpers', () => {
  it('never rounds an unfinished goal up to 100', () => {
    expect(wholePercent(99.6)).toBe(99)
    expect(wholePercent(82.4)).toBe(82)
    expect(wholePercent(100)).toBe(100)
    expect(wholePercent(undefined)).toBe(0)
  })

  it('reads and clamps the percent', () => {
    expect(goalPercent({ progress: { percent: 42.5 } })).toBe(42.5)
    expect(goalPercent({ progress: { percent: 140 } })).toBe(100)
    expect(goalPercent({})).toBe(0)
  })

  it('knows a finished goal and needs cards to count', () => {
    expect(isGoalComplete({ progress: { total: 3, missing: 0 } })).toBe(true)
    expect(isGoalComplete({ progress: { total: 3, missing: 1 } })).toBe(false)
    expect(isGoalComplete({ progress: { total: 0, missing: 0 } })).toBe(false)
  })

  it('keeps only pinned goals', () => {
    expect(pinnedGoals([{ id: 1, pinned: true }, { id: 2, pinned: false }]).map(goal => goal.id)).toEqual([1])
    expect(pinnedGoals(undefined)).toEqual([])
  })

  it('builds set params from a set row', () => {
    expect(setGoalParams({ id: 'sv1_en', tcg_set_id: 'sv1', lang: 'en' })).toEqual({ set_id: 'sv1', lang: 'en' })
    expect(setGoalParams({ id: 'base1_de', lang: 'de' })).toEqual({ set_id: 'base1', lang: 'de' })
  })
})
