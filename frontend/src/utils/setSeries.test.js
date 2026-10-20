import { describe, expect, it } from 'vitest'
import { groupSetsBySeries, seriesKeyOf, slugifySeries, yearsLabel } from './setSeries'

const set = (id, series, extra = {}) => ({ id, name: id.toUpperCase(), series, release_date: '2024-01-01', owned_count: 0, total: 10, ...extra })

describe('slugifySeries', () => {
  it('makes a url-safe slug', () => {
    expect(slugifySeries('Scarlet & Violet')).toBe('scarlet-violet')
    expect(slugifySeries('Pokémon TCG')).toBe('pokemon-tcg')
    expect(slugifySeries('')).toBe('other')
  })
})

describe('seriesKeyOf', () => {
  it('prefers series_id, else a slug of the name', () => {
    expect(seriesKeyOf({ series_id: 'sv', series: 'Scarlet & Violet' })).toBe('sv')
    expect(seriesKeyOf({ series: 'Sword & Shield' })).toBe('sword-shield')
  })
})

describe('yearsLabel', () => {
  it('gives one year or a range', () => {
    expect(yearsLabel([{ release_date: '2023-03-01' }])).toBe('2023')
    expect(yearsLabel([{ release_date: '2019-03-01' }, { release_date: '2023-03-01' }])).toBe('2019 – 2023')
    expect(yearsLabel([{}])).toBe('')
  })
})

describe('groupSetsBySeries', () => {
  const sets = [
    set('sv1', 'Scarlet & Violet', { release_date: '2023-03-31', owned_count: 4, total: 10, series_id: 'sv' }),
    set('sv2', 'Scarlet & Violet', { release_date: '2023-06-09', owned_count: 6, total: 20, series_id: 'sv' }),
    set('swsh1', 'Sword & Shield', { release_date: '2020-02-07', owned_count: 5, total: 5 }),
    set('swsh2', 'Sword & Shield', { release_date: '2020-05-01', owned_count: 0, total: 0 }),
    set('base1', 'Base', { release_date: '1999-01-09', name: 'Base', owned_count: 1, total: 4 }),
  ]
  const groups = groupSetsBySeries(sets)

  it('groups by series_id or by name, newest series first', () => {
    expect(groups.map(g => g.key)).toEqual(['sv', 'sword-shield', 'base'])
  })
  it('sums owned and total and counts sets', () => {
    expect(groups[0]).toMatchObject({ owned: 10, total: 30, setCount: 2, complete: false })
    expect(groups[1]).toMatchObject({ owned: 5, total: 5, setCount: 2, complete: true })
  })
  it('keeps the grand totals equal to the sum of the sets', () => {
    expect(groups.reduce((s, g) => s + g.total, 0)).toBe(sets.reduce((s, x) => s + x.total, 0))
    expect(groups.reduce((s, g) => s + g.owned, 0)).toBe(sets.reduce((s, x) => s + x.owned_count, 0))
  })
  it('gives years and newest-first sets', () => {
    expect(groups[0].years).toBe('2023')
    expect(groups[0].sets.map(s => s.id)).toEqual(['sv2', 'sv1'])
  })
  it('uses the series route when sets carry series_id, else the namesake or newest set logo', () => {
    expect(groups[0].logo).toMatch(/^\/api\/images\/set\/sv[12]\/series\?v=\d+$/)
    expect(groups[2].logo).toBe('/api/images/set/base1/logo')
    expect(groups[1].logo).toBe('/api/images/set/swsh2/logo')
  })
  it('lists the series route first, then the namesake or newest set logo, without repeats', () => {
    expect(groups[0].logoCandidates).toEqual([groups[0].logo, '/api/images/set/sv2/logo'])
    expect(groups[2].logoCandidates).toEqual(['/api/images/set/base1/logo'])
  })
  it('handles an empty list', () => {
    expect(groupSetsBySeries([])).toEqual([])
  })
})
