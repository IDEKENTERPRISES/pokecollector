import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clampPage,
  compareCollectorNumbers,
  gridForLayout,
  normalizePocketLayout,
  pageCount,
  pageItems,
  pageOfIndex,
  readViewPreference,
  renderedUnits,
  setBookItems,
  splitPages,
  unitCount,
  unitPages,
  writeViewPreference,
} from './bookPages'
import { splitVariantCards } from '../../utils/setDetailStats'

const tile = (id, number, owned = false) => ({
  key: id,
  source: { id, number, name: `Card ${id}` },
  card: { id, number, name: `Card ${id}`, owned, owned_quantity: owned ? 1 : 0 },
})

describe('pocket layouts', () => {
  it('supports 4, 9 and 12 and falls back to 9', () => {
    expect(normalizePocketLayout(4)).toBe(4)
    expect(normalizePocketLayout(12)).toBe(12)
    expect(normalizePocketLayout(undefined)).toBe(9)
    expect(normalizePocketLayout(7)).toBe(9)
    expect(gridForLayout(9)).toEqual({ cols: 3, rows: 3 })
    expect(gridForLayout(12)).toEqual({ cols: 4, rows: 3 })
    expect(gridForLayout(4)).toEqual({ cols: 2, rows: 2 })
  })
})

describe('page splitting', () => {
  const items = Array.from({ length: 20 }, (_, index) => ({ key: index }))

  it('splits into pages of the layout size, the last one short', () => {
    const pages = splitPages(items, 9)
    expect(pages.map(page => page.length)).toEqual([9, 9, 2])
    expect(pages[1][0].key).toBe(9)
    expect(splitPages(items, 4)).toHaveLength(5)
    expect(splitPages(items, 12).map(page => page.length)).toEqual([12, 8])
  })

  it('keeps one empty page for an empty book', () => {
    expect(pageCount(0, 9)).toBe(1)
    expect(splitPages([], 9)).toEqual([[]])
  })

  it('finds the page of an item and clamps page numbers', () => {
    expect(pageOfIndex(8, 9)).toBe(0)
    expect(pageOfIndex(9, 9)).toBe(1)
    expect(clampPage(99, 20, 9)).toBe(2)
    expect(clampPage(-3, 20, 9)).toBe(0)
    expect(clampPage('x', 20, 9)).toBe(0)
    expect(pageItems(items, 2, 9)).toHaveLength(2)
  })

  it('groups pages into spreads and renders only the current unit and its neighbours', () => {
    expect(unitCount(5, 2)).toBe(3)
    expect(unitPages(2, 2, 5)).toEqual([4])
    expect(unitPages(1, 2, 5)).toEqual([2, 3])
    expect(renderedUnits(0, 40)).toEqual([0, 1])
    expect(renderedUnits(10, 40)).toEqual([9, 10, 11])
    expect(renderedUnits(39, 40)).toEqual([38, 39])
  })
})

describe('collector-number order', () => {
  it('sorts numerically, not alphabetically, with gallery prefixes after plain numbers', () => {
    const numbers = ['10', '2', 'TG02', '100', '1', 'GG05']
    expect([...numbers].sort(compareCollectorNumbers)).toEqual(['1', '2', '10', '100', 'GG05', 'TG02'])
  })

  it('orders set tiles by number whatever the grid sort was, and marks missing cards as ghosts', () => {
    const items = setBookItems([tile('c', '10', true), tile('a', '2'), tile('b', '1', true)])
    expect(items.map(item => item.number)).toEqual(['1', '2', '10'])
    expect(items.map(item => item.ghost)).toEqual([false, true, false])
    expect(items[1].name).toBe('Card a')
  })

  it('gives each variant its own pocket, in order, owned or ghost per variant', () => {
    const card = {
      id: 'x', number: '5', name: 'Pika', variants_normal: true, variants_reverse: true,
      owned: true, owned_variants: [{ variant: 'Normal', quantity: 2 }],
    }
    const other = { id: 'y', number: '4', name: 'Eevee', variants_normal: true, owned: false }
    const tiles = [card, other].flatMap(entry => splitVariantCards(entry))
    const items = setBookItems(tiles)
    expect(items.map(item => item.key)).toEqual(['y:Normal', 'x:Normal', 'x:Reverse Holo'].filter(key => items.some(item => item.key === key)))
    const pika = items.filter(item => item.source.id === 'x')
    expect(pika.length).toBeGreaterThan(1)
    expect(pika.map(item => item.ghost)).toEqual([false, ...pika.slice(1).map(() => true)])
    expect(items[0].source.id).toBe('y')
  })

  it('shows only ghosts when every tile is missing', () => {
    expect(setBookItems([tile('a', '1'), tile('b', '2')]).every(item => item.ghost)).toBe(true)
  })
})

describe('view preference', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('remembers book per kind and falls back to grid', () => {
    const store = new Map()
    vi.stubGlobal('window', { localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) } })
    expect(readViewPreference('set')).toBe('grid')
    writeViewPreference('set', 'book')
    expect(readViewPreference('set')).toBe('book')
    expect(readViewPreference('binder')).toBe('grid')
    writeViewPreference('set', 'grid')
    expect(readViewPreference('set')).toBe('grid')
  })

  it('does not throw when storage is blocked', () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('blocked') } })
    expect(readViewPreference('set')).toBe('grid')
    expect(() => writeViewPreference('set', 'book')).not.toThrow()
  })
})
