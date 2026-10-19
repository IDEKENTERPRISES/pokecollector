import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BRAND, TYPE_COLOURS, TYPE_KEYS, colourFor, contrastRatio, hpFraction, hpTone, typeKeyFor, typeVar,
} from './pokemon'

const KNOWN = { sv: 'lightning', swsh: 'grass', base1: 'water', xy: 'fighting', 'sword-shield': 'fire' }

describe('energy-type palette', () => {
  it('has the eleven types of the design table', () => {
    expect(TYPE_KEYS).toHaveLength(11)
    expect(Object.keys(TYPE_COLOURS).sort()).toEqual([...TYPE_KEYS].sort())
  })

  it.each(TYPE_KEYS)('%s: tile text reaches 4.5:1 on both tile stops', (type) => {
    const { top, bottom, text } = TYPE_COLOURS[type]
    expect(contrastRatio(text, top)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(text, bottom)).toBeGreaterThanOrEqual(4.5)
  })

  it('computes WCAG ratios (white on black is 21:1)', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5)
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5)
  })

  it('keeps the CSS variables in index.css in step with the JS palette', () => {
    const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8')
    for (const type of TYPE_KEYS) {
      const { top, bottom, solid } = TYPE_COLOURS[type]
      expect(css.toLowerCase()).toContain(`--type-${type}-top: ${top.toLowerCase()}`)
      expect(css.toLowerCase()).toContain(`--type-${type}-bottom: ${bottom.toLowerCase()}`)
      expect(css.toLowerCase()).toMatch(new RegExp('--type-' + type + ': +' + solid.toLowerCase()))
    }
    expect(css.toLowerCase()).toContain(`--poke-red:    ${BRAND.red.toLowerCase()}`)
    expect(css.toLowerCase()).toContain(`--poke-yellow: ${BRAND.yellow.toLowerCase()}`)
    expect(css.toLowerCase()).toContain(`--poke-blue:   ${BRAND.blue.toLowerCase()}`)
  })

  it('normalises type names from card data', () => {
    expect(typeKeyFor('Lightning')).toBe('lightning')
    expect(typeKeyFor('Electric')).toBe('lightning')
    expect(typeKeyFor('Dark')).toBe('darkness')
    expect(typeKeyFor('Colorless')).toBe('colorless')
    expect(typeKeyFor('Steel')).toBe('metal')
    expect(typeKeyFor('nonsense')).toBeNull()
    expect(typeKeyFor(undefined)).toBeNull()
    expect(typeVar('Fire')).toBe('var(--type-fire)')
    expect(typeVar('fire', 'top')).toBe('var(--type-fire-top)')
    expect(typeVar('unknown')).toBe('var(--type-colorless)')
  })
})

describe('colourFor', () => {
  it('is stable: the same key always gives the same type', () => {
    for (const key of ['sv', 'swsh12', 'base1', 'Sword & Shield', '']) {
      expect(colourFor(key)).toBe(colourFor(key))
      expect(TYPE_KEYS).toContain(colourFor(key))
    }
  })

  it('keeps known keys on known types (a changed hash would recolour every banner)', () => {
    expect({
      sv: colourFor('sv'),
      swsh: colourFor('swsh'),
      base1: colourFor('base1'),
      xy: colourFor('xy'),
      'sword-shield': colourFor('sword-shield'),
    }).toEqual(KNOWN)
  })

  it('spreads keys over more than one type', () => {
    const seen = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].map(colourFor))
    expect(seen.size).toBeGreaterThan(4)
  })

  it('tolerates missing keys', () => {
    expect(TYPE_KEYS).toContain(colourFor(undefined))
    expect(TYPE_KEYS).toContain(colourFor(null))
  })
})

describe('HP bar thresholds', () => {
  it('is green above 50 %', () => {
    expect(hpTone(51, 100)).toBe('green')
    expect(hpTone(100, 100)).toBe('green')
    expect(hpTone(0.501, 1)).toBe('green')
  })

  it('is yellow from 20 % to 50 % inclusive', () => {
    expect(hpTone(50, 100)).toBe('yellow')
    expect(hpTone(35, 100)).toBe('yellow')
    expect(hpTone(20, 100)).toBe('yellow')
  })

  it('is red below 20 %', () => {
    expect(hpTone(19, 100)).toBe('red')
    expect(hpTone(0, 100)).toBe('red')
  })

  it('handles empty, invalid and overfull input', () => {
    expect(hpFraction(5, 0)).toBe(0)
    expect(hpTone(5, 0)).toBe('red')
    expect(hpFraction(NaN, 10)).toBe(0)
    expect(hpFraction(-3, 10)).toBe(0)
    expect(hpFraction(30, 10)).toBe(1)
    expect(hpFraction('5', '10')).toBe(0.5)
  })
})
