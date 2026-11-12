import { describe, expect, it } from 'vitest'
import { clahe, cropFraction, prepare, resizeCubicZoom, resizeLinear, rotate180, rotate90, warpBox } from './image'
import { readFixture, rgbToImage, unpack } from './testkit'

const reference = readFixture('ocr-ops.json')
const byName = Object.fromEntries(reference.cases.map(item => [item.name, item]))

// How far a port pixel may sit from OpenCV's 8-bit fixed-point result (levels of 0..255): the mean over the picture and the share
// of pixels that differ by more than two levels. Measured values are in docs/phone-scanner/ocr.md.
function compare(image, item) {
  const expected = unpack(item.output)
  expect(image.width).toBe(item.out_width)
  expect(image.height).toBe(item.out_height)
  let sum = 0
  let far = 0
  let worst = 0
  const count = image.width * image.height * 3
  for (let i = 0; i < image.width * image.height; i++) {
    for (let c = 0; c < 3; c++) {
      const diff = Math.abs(image.data[i * 4 + c] - expected[i * 3 + c])
      sum += diff
      if (diff > 2) far++
      worst = Math.max(worst, diff)
    }
  }
  return { mean: sum / count, far: far / count, worst }
}

const input = item => rgbToImage(unpack(item.input), item.width, item.height)

describe('picture operations against OpenCV', () => {
  it.each(['cubic-2', 'cubic-2.5', 'cubic-3'])('%s: bicubic zoom is within a level', name => {
    const item = byName[name === 'cubic-2' ? 'cubic-2.0' : name === 'cubic-3' ? 'cubic-3.0' : name]
    const result = compare(resizeCubicZoom(input(item), item.zoom), item)
    expect(result.mean).toBeLessThan(0.05)
    expect(result.worst).toBeLessThanOrEqual(1)
  })

  it('sharp (unsharp mask) is within a level', () => {
    const item = byName.sharp
    const result = compare(prepare(input(item), 'sharp'), item)
    expect(result.mean).toBeLessThan(0.5)
    expect(result.worst).toBeLessThanOrEqual(2)
  })

  it.each(['clahe', 'clahe-small'])('%s: local contrast stays close to OpenCV (LAB in floating point)', name => {
    const item = byName[name]
    const result = compare(prepare(input(item), 'clahe'), item)
    expect(result.mean).toBeLessThan(1.5)
    expect(result.worst).toBeLessThanOrEqual(6)
  })

  it.each(['linear-down', 'linear-up'])('%s: bilinear resize is within a level', name => {
    const item = byName[name]
    const result = compare(resizeLinear(input(item), item.size[0], item.size[1]), item)
    expect(result.mean).toBeLessThan(0.05)
    expect(result.worst).toBeLessThanOrEqual(2)
  })

  it('turns a picture half way round', () => {
    const item = byName.rot180
    expect(compare(rotate180(input(item)), item).worst).toBe(0)
  })

  it.each(['warp-turned', 'warp-tall'])('%s: the perspective crop matches RapidOCR\'s', name => {
    const item = byName[name]
    const result = compare(warpBox(input(item), item.points), item)
    expect(result.mean).toBeLessThan(0.05)
    expect(result.worst).toBeLessThanOrEqual(1)
  })

  it('np.rot90 turns a picture a quarter counter-clockwise', () => {
    const img = { data: new Uint8ClampedArray([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255, 5, 0, 0, 255, 6, 0, 0, 255]), width: 3, height: 2 }
    const out = rotate90(img)
    expect([out.width, out.height]).toEqual([2, 3])
    expect([0, 1, 2, 3, 4, 5].map(i => out.data[i * 4])).toEqual([3, 6, 2, 5, 1, 4])
  })

  it('cuts regions with int() truncation, like ocr.py', () => {
    const img = { data: new Uint8ClampedArray(10 * 10 * 4), width: 10, height: 10 }
    const crop = cropFraction(img, [0.05, 0.95, 0.55, 1.0])
    expect([crop.width, crop.height]).toEqual([5, 1]) // int(0.5) = 0 .. int(5.5) = 5; int(9.5) = 9 .. 10
  })

  it('refuses the slow variants, which the fast ladder never uses', () => {
    expect(() => prepare({ data: new Uint8ClampedArray(4), width: 1, height: 1 }, 'binary')).toThrow()
  })

  it('CLAHE of a flat plane stays flat', () => {
    const plane = new Uint8Array(48 * 24).fill(100)
    const out = clahe(plane, 48, 24, 3.0, 8, 3)
    expect(new Set(out).size).toBe(1)
  })
})
