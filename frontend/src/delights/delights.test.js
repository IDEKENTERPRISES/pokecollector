import { describe, expect, it } from 'vitest'
import { SHOWCASE_MAX, arcPath, barWidths, donutSegments, fill, hasOnThisDay, showcaseChanged, toggleShowcase } from './delights'

describe('hasOnThisDay', () => {
  it('needs at least one earlier year', () => {
    expect(hasOnThisDay(null)).toBe(false)
    expect(hasOnThisDay({ years: [] })).toBe(false)
    expect(hasOnThisDay({ years: [{ year: 2024, count: 1 }] })).toBe(true)
  })
})

describe('toggleShowcase', () => {
  it('adds in order, removes, and stops at six', () => {
    expect(toggleShowcase([], 4)).toEqual([4])
    expect(toggleShowcase([4, 5], 4)).toEqual([5])
    const full = [1, 2, 3, 4, 5, 6]
    expect(full).toHaveLength(SHOWCASE_MAX)
    expect(toggleShowcase(full, 7)).toBe(full)
    expect(toggleShowcase(full, 3)).toEqual([1, 2, 4, 5, 6])
  })

  it('knows when the pick differs from the saved list', () => {
    expect(showcaseChanged([1, 2], [1, 2])).toBe(false)
    expect(showcaseChanged([1, 2], [2, 1])).toBe(true)
    expect(showcaseChanged([1], [])).toBe(true)
  })
})

describe('donutSegments', () => {
  it('splits a turn by share and drops empty types', () => {
    const segments = donutSegments([{ type: 'fire', count: 3 }, { type: 'water', count: 1 }, { type: 'grass', count: 0 }])
    expect(segments.map(s => s.type)).toEqual(['fire', 'water'])
    expect(segments[0]).toMatchObject({ start: 0, end: 0.75 })
    expect(segments[1].end).toBeCloseTo(1)
    expect(donutSegments([])).toEqual([])
  })

  it('draws a single type as a near-full ring with finite coordinates', () => {
    const [only] = donutSegments([{ type: 'fire', count: 5 }])
    expect(arcPath(only.start, only.end)).not.toMatch(/NaN/)
  })
})

describe('barWidths', () => {
  it('scales to the largest count with a visible minimum', () => {
    expect(barWidths([{ count: 10 }, { count: 5 }, { count: 0 }]).map(r => r.width)).toEqual([100, 50, 4])
    expect(barWidths([])).toEqual([])
  })
})

describe('fill', () => {
  it('replaces every placeholder', () => {
    expect(fill('{a} and {a} of {b}', { a: 1, b: 2 })).toBe('1 and 1 of 2')
  })
})
