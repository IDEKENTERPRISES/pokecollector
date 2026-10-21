import { describe, expect, it } from 'vitest'
import { BALL_BASE, BALL_LID, BURST, GRASS, artSize, pixelPaths } from './art.js'
import { contentBounds, fitSprite } from './spriteFit.js'

describe('pixel art', () => {
  it('every map is a clean rectangle in its own palette', () => {
    for (const art of [BALL_LID, BALL_BASE, BURST, GRASS]) {
      const { width } = artSize(art)
      for (const row of art.rows) {
        expect(row).toHaveLength(width)
        for (const key of row) expect(key === '.' || key in art.palette, `${key} in ${row}`).toBe(true)
      }
    }
  })

  it('the ball is 16 x 16, split at the band', () => {
    expect(artSize(BALL_LID)).toEqual({ width: 16, height: 8 })
    expect(artSize(BALL_BASE)).toEqual({ width: 16, height: 8 })
    expect(artSize(GRASS)).toEqual({ width: 48, height: 5 })
  })

  it('merges each colour into one path of horizontal runs', () => {
    const paths = pixelPaths({ rows: ['aab.', '.bbb'], palette: { a: '#f00', b: '#00f' } })
    expect(paths).toEqual([
      { key: 'a', fill: '#f00', d: 'M0 0h2v1h-2z' },
      { key: 'b', fill: '#00f', d: 'M2 0h1v1h-1zM1 1h3v1h-3z' },
    ])
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

  it('scales by a whole number from the visible size and stands the sprite on the ground', () => {
    // A 96 x 96 static sprite whose creature fills 40 x 32 pixels, 20 pixels above the bottom.
    const fit = fitSprite({ width: 96, height: 96, bounds: { top: 44, left: 30, right: 70, bottom: 76 }, target: 144 })
    expect(fit).toEqual({ width: 384, height: 384, marginBottom: -80, left: -8 })
  })

  it('keeps between 2x and 4x, and works without bounds', () => {
    expect(fitSprite({ width: 200, height: 200, bounds: null, target: 144 }).width).toBe(400)
    expect(fitSprite({ width: 10, height: 10, bounds: null, target: 144 }).width).toBe(40)
    expect(fitSprite({ width: 50, height: 46, bounds: null, target: 144 })).toEqual({ width: 150, height: 138, marginBottom: 0, left: 0 })
  })
})
