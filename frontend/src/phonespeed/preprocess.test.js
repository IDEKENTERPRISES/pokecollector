import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import jpeg from 'jpeg-js'
import { describe, expect, it } from 'vitest'
import { fromHalfBits, INPUT_SIZE, preprocessRgba, resizeArea, tensorStats, toHalfBits, VIEWS_PER_CARD } from './preprocess'

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'phone-matcher', 'v11')
const readJson = name => JSON.parse(readFileSync(resolve(fixtures, name), 'utf-8'))

// The tolerance, in tensor units. One 8-bit level is 1/255/std = 0.0174 (std 0.225). cv2 rounds each resized pixel to a level
// (the cubic in 11-bit fixed point, the area average in float), this port rounds to the nearest level: a pixel may differ by one.
const ONE_LEVEL = 1 / 255 / 0.224
const SAMPLE_TOLERANCE = ONE_LEVEL * 1.05

function pattern(width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) rgba[(y * width + x) * 4 + c] = (x * 7 + y * 13 + c * 50 + ((x * y) % 17) * 5) % 256
      rgba[(y * width + x) * 4 + 3] = 255
    }
  }
  return rgba
}

describe('preprocess port (embed.preprocess, matcher version 11)', () => {
  const reference = readJson('preprocess-reference.json')

  it('matches cv2 on generated patterns, for shrinking (area) and enlarging (cubic) pictures', () => {
    expect(reference.matcher_version).toBe('11')
    const methods = new Set(reference.cases.map(item => item.method))
    expect(methods).toEqual(new Set(['area', 'cubic']))
    for (const item of reference.cases) {
      const tensor = preprocessRgba(pattern(item.width, item.height), item.width, item.height)
      expect(tensor).toHaveLength(3 * INPUT_SIZE * INPUT_SIZE)
      const stats = tensorStats(tensor)
      expect(Math.abs(stats.mean - item.mean)).toBeLessThan(0.003)
      expect(Math.abs(stats.std - item.std)).toBeLessThan(0.003)
      let worst = 0
      item.samples.forEach((value, i) => { worst = Math.max(worst, Math.abs(tensor[i * item.step] - value)) })
      expect(worst, `${item.width}x${item.height} ${item.method}`).toBeLessThanOrEqual(SAMPLE_TOLERANCE)
    }
  })

  it('is channel-first RGB with the ImageNet normalisation', () => {
    const rgba = new Uint8ClampedArray(4 * 4 * 4)
    for (let i = 0; i < 16; i++) rgba.set([255, 0, 128, 255], i * 4)
    const tensor = preprocessRgba(rgba, 4, 4)
    const plane = INPUT_SIZE * INPUT_SIZE
    expect(tensor[0]).toBeCloseTo((1 - 0.485) / 0.229, 5)
    expect(tensor[plane]).toBeCloseTo((0 - 0.456) / 0.224, 5)
    expect(tensor[2 * plane]).toBeCloseTo((128 / 255 - 0.406) / 0.225, 5)
    expect(tensor[3 * plane - 1]).toBeCloseTo((128 / 255 - 0.406) / 0.225, 5)
  })

  it('averages whole blocks exactly when the shrink factor is an integer', () => {
    const rgba = new Uint8ClampedArray(4 * 4 * 4)
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) rgba.set([x * 10 + y, 0, 0, 255], (y * 4 + x) * 4)
    const rgb = resizeArea(rgba, 4, 4, 2, 2)
    expect(rgb[0]).toBe(Math.round((0 + 10 + 1 + 11) / 4)) // top-left block
    expect(rgb[3]).toBe(Math.round((20 + 30 + 21 + 31) / 4)) // top-right block
  })

  it('parity with the committed photo cases: the flat card of each generated photo gives the fixture tensor stats', () => {
    // The fixture's tensor comes from the finder's flat 630x880 card. The test rebuilds that card from the JPEG with the
    // fixture's corners (a pure-JS decoder and a bilinear homography, where cv2 uses its own JPEG decoder and a cubic warp),
    // so the card differs by a little at edges and strokes: the tolerance is on the whole-tensor mean and std, not per pixel.
    const photos = readJson('photos.json')
    expect(photos.preprocess.size).toBe(INPUT_SIZE)
    expect(photos.cases.length).toBeGreaterThan(0)
    for (const item of photos.cases) {
      const decoded = jpeg.decode(readFileSync(resolve(fixtures, item.photo)), { useTArray: true, formatAsRGBA: true })
      expect([decoded.width, decoded.height]).toEqual(item.photo_size)
      const [width, height] = item.detection.flat_size
      const flat = warp(decoded, item.detection.corners, width, height)
      const stats = tensorStats(preprocessRgba(flat, width, height))
      expect(Math.abs(stats.mean - item.tensor.mean), `${item.photo} mean`).toBeLessThan(0.05)
      expect(Math.abs(stats.std - item.tensor.std), `${item.photo} std`).toBeLessThan(0.05)
    }
  })

  it('writes half-precision bits for a float16 model input', () => {
    const bits = toHalfBits(new Float32Array([0, 1, -2, 0.5, 65504, 1e-8, 70000, 0.333251953125]))
    expect([...bits]).toEqual([0x0000, 0x3c00, 0xc000, 0x3800, 0x7bff, 0x0000, 0x7c00, 0x3555])
  })

  it('reads half-precision bits back', () => {
    const values = new Float32Array([0, 1, -2, 0.5, 65504, 0.333251953125, 1e-5])
    const back = fromHalfBits(toHalfBits(values))
    values.forEach((value, i) => expect(Math.abs(back[i] - value)).toBeLessThanOrEqual(Math.abs(value) * 1e-3 + 1e-7))
  })

  it('knows how many views the kept option set embeds per card', () => {
    expect(VIEWS_PER_CARD).toEqual({ orientation: 2, tta: 2, art: 3, total: 7 })
  })
})

/** Flatten the quad (tl, tr, br, bl) to width x height RGBA with a bilinear sampler (the finder's warp_card, simplified). */
function warp(image, corners, width, height) {
  const [tl, tr, br, bl] = corners
  const out = new Uint8ClampedArray(width * height * 4)
  const src = image.data
  const sample = (x, y, c) => {
    const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(x)))
    const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(y)))
    const x1 = Math.min(image.width - 1, x0 + 1)
    const y1 = Math.min(image.height - 1, y0 + 1)
    const fx = Math.max(0, Math.min(1, x - x0))
    const fy = Math.max(0, Math.min(1, y - y0))
    const at = (xx, yy) => src[(yy * image.width + xx) * 4 + c]
    return (at(x0, y0) * (1 - fx) + at(x1, y0) * fx) * (1 - fy) + (at(x0, y1) * (1 - fx) + at(x1, y1) * fx) * fy
  }
  // the homography of the unit square onto the quad (projective mapping, Heckbert)
  const [x0, y0] = tl
  const [x1, y1] = tr
  const [x2, y2] = br
  const [x3, y3] = bl
  const dx1 = x1 - x2
  const dx2 = x3 - x2
  const dx3 = x0 - x1 + x2 - x3
  const dy1 = y1 - y2
  const dy2 = y3 - y2
  const dy3 = y0 - y1 + y2 - y3
  const det = dx1 * dy2 - dx2 * dy1
  const g = (dx3 * dy2 - dx2 * dy3) / det
  const h = (dx1 * dy3 - dx3 * dy1) / det
  const a = x1 - x0 + g * x1
  const b = x3 - x0 + h * x3
  const d = y1 - y0 + g * y1
  const e = y3 - y0 + h * y3
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1)
      const v = y / (height - 1)
      const w = g * u + h * v + 1
      const sx = (a * u + b * v + x0) / w
      const sy = (d * u + e * v + y0) / w
      for (let c = 0; c < 3; c++) out[(y * width + x) * 4 + c] = sample(sx, sy, c)
      out[(y * width + x) * 4 + 3] = 255
    }
  }
  return out
}
