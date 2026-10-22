import { describe, expect, it } from 'vitest'
import pokedex from '../../../../backend/data/pokedex.json'
import en from '../../i18n/en.js'
import de from '../../i18n/de.js'
import {
  BALL_BASE, BALL_LID, BURST, GLYPH_ADVANCE, GROUNDS, SPARKLE, artSize, groundFor, groundName, pixelPaths, textArt,
} from './art.js'
import { contentBounds, fitSprite } from './spriteFit.js'

describe('pixel art', () => {
  it('every map is a clean rectangle in its own palette', () => {
    for (const art of [BALL_LID, BALL_BASE, BURST, SPARKLE, ...Object.values(GROUNDS)]) {
      const { width } = artSize(art)
      for (const row of art.rows) {
        expect(row).toHaveLength(width)
        for (const key of row) expect(key === '.' || key in art.palette, `${key} in ${row}`).toBe(true)
      }
    }
  })

  it('the ball is 16 x 16, split at the band, and every ground is 48 x 5', () => {
    expect(artSize(BALL_LID)).toEqual({ width: 16, height: 8 })
    expect(artSize(BALL_BASE)).toEqual({ width: 16, height: 8 })
    for (const [name, ground] of Object.entries(GROUNDS)) expect(artSize(ground), name).toEqual({ width: 48, height: 5 })
  })

  it('every type in the Pokédex has a ground of its own', () => {
    const types = new Set(pokedex.flatMap(entry => entry.types))
    expect(types.size).toBe(18)
    expect(new Set(Object.keys(GROUNDS))).toEqual(types)
    for (const type of types) {
      expect(groundName([type]), type).toBe(type)
      expect(groundFor([type]), type).toBe(GROUNDS[type])
    }
    // No two types share a drawing, so no type falls back to grass.
    const drawings = new Set(Object.values(GROUNDS).map(ground => ground.rows.join('\n')))
    expect(drawings.size).toBe(18)
  })

  it('uses the first type, and grass only for an unknown type', () => {
    expect(groundFor(['water', 'flying'])).toBe(GROUNDS.water)
    expect(groundName(['Psychic'])).toBe('psychic')
    expect(groundFor(undefined)).toBe(GROUNDS.grass)
    expect(groundFor(['stellar'])).toBe(GROUNDS.grass)
  })

  it('lifts the ball onto flat floors by at most two art pixels', () => {
    for (const [type, ground] of Object.entries(GROUNDS)) {
      expect([0, 1, 2], type).toContain(ground.lift ?? 0)
    }
    expect(GROUNDS.fighting.lift).toBe(1)
    expect(GROUNDS.grass.lift ?? 0).toBe(0)
  })

  it('the light takes the type colour', () => {
    expect(pixelPaths(BURST).find(path => path.key === 'w').fill).toBe('currentColor')
  })

  it('merges each colour into one path of horizontal runs', () => {
    const paths = pixelPaths({ rows: ['aab.', '.bbb'], palette: { a: '#f00', b: '#00f' } })
    expect(paths).toEqual([
      { key: 'a', fill: '#f00', d: 'M0 0h2v1h-2z' },
      { key: 'b', fill: '#00f', d: 'M2 0h1v1h-1zM1 1h3v1h-3z' },
    ])
  })
})

describe('the pixel font', () => {
  it('draws letters six pixels apart', () => {
    const art = textArt('Hi!')
    expect(artSize(art)).toEqual({ width: 3 * GLYPH_ADVANCE - 1, height: 8 })
    expect(art.rows[0].slice(0, 5)).toBe('t...t') // H
    expect(art.rows[6].slice(12, 17)).toBe('..t..') // the dot of !
  })

  it('covers every Pokémon name in capitals and the box sentences in English and German', () => {
    const sentences = [en.splash.wildLine1, en.splash.wildLine2, de.splash.wildLine1, de.splash.wildLine2]
      .map(line => line.replace('{name}', ''))
    const names = pokedex.flatMap(entry => [entry.name_en.toUpperCase(), entry.name_de.toUpperCase()])
    for (const text of [...sentences, ...names]) {
      const art = textArt(text)
      // A glyph that is missing would leave a blank where a visible character should be.
      ;[...text].forEach((char, index) => {
        if (char === ' ') return
        const columns = art.rows.map(row => row.slice(index * GLYPH_ADVANCE, index * GLYPH_ADVANCE + 5)).join('')
        expect(columns.includes('t'), `${char} in ${text}`).toBe(true)
      })
    }
  })
})

describe('sprite fitting', () => {
  const rgba = (width, height, opaque) => {
    const data = new Uint8ClampedArray(width * height * 4)
    for (const [x, y] of opaque) data[(y * width + x) * 4 + 3] = 255
    return data
  }

  it('finds the visible pixels', () => {
    expect(contentBounds(rgba(6, 5, [[2, 1], [4, 3]]), 6, 5)).toEqual({ top: 1, left: 2, right: 5, bottom: 4 })
    expect(contentBounds(rgba(3, 3, []), 3, 3)).toBeNull()
  })

  it('pixel sprites: a whole number from the visible size, standing on the ground', () => {
    // A 96 x 96 static sprite whose creature fills 40 x 32 pixels, 20 pixels above the bottom.
    const fit = fitSprite({ width: 96, height: 96, bounds: { top: 44, left: 30, right: 70, bottom: 76 }, target: 144 })
    expect(fit).toEqual({ width: 384, height: 384, marginBottom: -80, left: -8 })
    expect(fitSprite({ width: 200, height: 200, bounds: null, target: 144 }).width).toBe(400)
    expect(fitSprite({ width: 10, height: 10, bounds: null, target: 144 }).width).toBe(40)
  })

  it('animated and artwork sprites scale smoothly, never more than twice', () => {
    expect(fitSprite({ width: 60, height: 60, bounds: null, target: 132, smooth: true }).width).toBe(120)
    expect(fitSprite({ width: 475, height: 475, bounds: { top: 40, left: 40, right: 435, bottom: 455 }, target: 132, smooth: true }))
      .toEqual({ width: 151, height: 151, marginBottom: -6, left: 0 })
    expect(fitSprite({ width: 96, height: 80, bounds: null, target: 132, smooth: true, maxSmooth: 1 }).width).toBe(96)
  })
})
