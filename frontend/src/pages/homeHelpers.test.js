import { describe, expect, it } from 'vitest'
import {
  pluralKey, closestToCompleteSets, completeSetCount, minutesSince, seriesChange, shortAge, todoCards, trackerSeries,
} from './homeHelpers'

const sets = [
  { id: 'a', total: 10, owned_count: 10 },
  { id: 'b', total: 10, owned_count: 9 },
  { id: 'c', total: 100, owned_count: 90 },
  { id: 'd', total: 10, owned_count: 0 },
  { id: 'e', total: 0, owned_count: 0 },
  { id: 'f', total: 20, owned_count: 2 },
]

describe('set helpers', () => {
  it('counts complete sets and ignores empty ones', () => {
    expect(completeSetCount(sets)).toBe(1)
    expect(completeSetCount(undefined)).toBe(0)
  })
  it('orders unfinished started sets by completion, larger set first on ties', () => {
    expect(closestToCompleteSets(sets).map(s => s.id)).toEqual(['c', 'b', 'f'])
    expect(closestToCompleteSets(sets, 1).map(s => s.id)).toEqual(['c'])
  })
})

describe('pluralKey', () => {
  it('uses the singular key only for exactly one', () => {
    expect(pluralKey('home.todoSync', 1)).toBe('home.todoSyncOne')
    expect(pluralKey('home.todoSync', 2)).toBe('home.todoSync')
    expect(pluralKey('home.todoSync', 0)).toBe('home.todoSync')
  })
})

describe('todoCards', () => {
  it('shows nothing when every count is zero', () => {
    expect(todoCards()).toEqual([])
  })
  it('shows each card only for a non-zero count', () => {
    const cards = todoCards({ scanAttention: 2, queueEnabled: true, outboxCount: 3, customMatches: 1, productsToReview: 4, newSets: 5 })
    expect(cards.map(c => c.key)).toEqual(['scans-review', 'sync', 'matches', 'products', 'new-sets'])
  })
  it('shows processing only when nothing needs review', () => {
    expect(todoCards({ scansActive: true }).map(c => c.key)).toEqual(['scans-processing'])
    expect(todoCards({ scansActive: true, scanAttention: 1 }).map(c => c.key)).toEqual(['scans-review'])
  })
  it('hides the sync card when the queue flag is off', () => {
    expect(todoCards({ outboxCount: 3 })).toEqual([])
  })
})

describe('tracker helpers', () => {
  it('reads a field and the change over it', () => {
    const tracker = [{ value: 10, cost: 5 }, { value: 'x' }, { value: 16.5, cost: 5 }]
    expect(trackerSeries(tracker)).toEqual([10, 16.5])
    expect(seriesChange([10, 16.5])).toBe(6.5)
    expect(seriesChange([10])).toBeNull()
  })
})

describe('price age', () => {
  const now = Date.parse('2026-10-20T12:00:00Z')
  it('measures minutes and formats them', () => {
    expect(minutesSince('2026-10-20T11:48:00Z', now)).toBe(12)
    expect(minutesSince(null, now)).toBeNull()
    expect(minutesSince('nope', now)).toBeNull()
    expect(shortAge(12)).toBe('12 min')
    expect(shortAge(0)).toBe('<1 min')
    expect(shortAge(180)).toBe('3 h')
    expect(shortAge(60 * 49)).toBe('2 d')
    expect(shortAge(null)).toBeNull()
  })
})
