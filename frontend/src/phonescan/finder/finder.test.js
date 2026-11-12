import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import jpeg from 'jpeg-js'
import { describe, expect, it } from 'vitest'
import { resizeArea } from '../../phonespeed/preprocess'
import { clahe8, lab8ToRgb, rgbToLab8 } from './color'
import {
  approxPolyDPClosed, arcLengthClosed, canny, closeBinary, contourArea, convexHull, findContours, gaussian5, grayFromRgba, minAreaBox,
  otsuBinary,
} from './cv'
import {
  artCrop, augmentedViews, cardViews, findCard, guideRect, hiresSize, isGuidePicture, orderCorners, plausibilityProblem, quadMeasures,
  warpCard, wholeCard, wholeDetection,
} from './finder'

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'phone-matcher', 'v11', 'finder')
const reference = JSON.parse(readFileSync(resolve(fixtures, 'finder.json'), 'utf-8'))

// Tolerances (the reasons are in docs/phone-scanner/finder.md). The expected values were computed by OpenCV 4.10 from the very pixels
// jpeg-js decodes here (see decode_like_the_tests in backend/scripts/phone_parity_finder.py), so what is left is the port's own rounding:
// - the source (quad / guide / whole), the refusal reason, and the contours, hulls and polygon approximations are exact;
// - a quad corner moves by well under a hundredth of a pixel (the measured worst is 0.004 px: float32 against float64), so 0.05 px;
// - the flat card is a cubic warp: cv2 uses 1/32-pixel positions and 15-bit weights, this port the same positions and float weights,
//   so a pixel may be one level apart: the 8x11 grid of averages differs by at most 1 level of 255 (mean and std by 0.5);
// - the CLAHE view goes through Lab; cv2's own conversion is a fixed-point table, this one a float formula, and CLAHE stretches the
//   difference: up to 4 levels measured, so 5 on the grid of that view and of its artwork crop.
const QUAD_TOLERANCE_PX = 0.05
const GRID_TOLERANCE = 1.0
const MEAN_TOLERANCE = 0.5
const STD_TOLERANCE = 0.5
const CLAHE_GRID_TOLERANCE = 5.0
const CLAHE_MEAN_TOLERANCE = 1.5
const CLAHE_STD_TOLERANCE = 2.0
const CONFIDENCE_TOLERANCE = 0.002

function decode(name) {
  const { data, width, height } = jpeg.decode(readFileSync(resolve(fixtures, name)), { useTArray: true, formatAsRGBA: true })
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height }
}

function statsOf(image) {
  const n = image.width * image.height
  const mean = [0, 0, 0]
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) mean[c] += image.data[i * 4 + c]
  const std = [0, 0, 0]
  for (let c = 0; c < 3; c++) mean[c] /= n
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) std[c] += (image.data[i * 4 + c] - mean[c]) ** 2
  const [gw, gh] = reference.constants.grid
  const grid = resizeArea(image.data, image.width, image.height, gw, gh, 4)
  return { size: [image.width, image.height], mean, std: std.map(v => Math.sqrt(v / n)), grid: Array.from(grid) }
}

function compareStats(label, got, want, gridTolerance = GRID_TOLERANCE) {
  const loose = gridTolerance > GRID_TOLERANCE
  expect(got.size, `${label} size`).toEqual(want.size)
  got.mean.forEach((v, c) => expect(Math.abs(v - want.mean[c]), `${label} mean ${c}`).toBeLessThanOrEqual(loose ? CLAHE_MEAN_TOLERANCE : MEAN_TOLERANCE))
  got.std.forEach((v, c) => expect(Math.abs(v - want.std[c]), `${label} std ${c}`).toBeLessThanOrEqual(loose ? CLAHE_STD_TOLERANCE : STD_TOLERANCE))
  let worst = 0
  got.grid.forEach((v, i) => { worst = Math.max(worst, Math.abs(v - want.grid[i])) })
  expect(worst, `${label} grid`).toBeLessThanOrEqual(gridTolerance)
  return worst
}

// the formulas of backend/scripts/phone_parity_finder.py
function patternRgba(width, height) {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) out[(y * width + x) * 4 + c] = (x * 7 + y * 13 + c * 50 + ((x * y) % 17) * 5) % 256
      out[(y * width + x) * 4 + 3] = 255
    }
  }
  return out
}

function shapesImage(width, height) {
  const img = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) img[y * width + x] = (x * 2 + y) % 90 + 20
  for (let y = 10; y < 50; y++) for (let x = 12; x < 70; x++) img[y * width + x] = 200
  for (let y = 22; y < 34; y++) for (let x = 30; x < 44; x++) img[y * width + x] = 60
  for (let t = 0; t < 60; t++) {
    for (let y = 60 + Math.floor(t / 2); y < 64 + Math.floor(t / 2); y++) for (let x = 20 + t; x < 24 + t; x++) img[y * width + x] = 230
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const r2 = (x - 120) ** 2 + (y - 40) ** 2
      if (r2 >= 18 ** 2 && r2 <= 26 ** 2) img[y * width + x] = 255
    }
  }
  return img
}

const checksum = (values, modulo = null) => {
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i] * (modulo ? i % modulo : i + 1)
  return sum
}
const countOn = values => values.reduce((n, v) => n + (v > 0 ? 1 : 0), 0)

describe('the pieces of the finder against OpenCV 4.10', () => {
  const pieces = reference.pieces
  const W = 160
  const H = 120
  const shapes = shapesImage(W, H)

  it('blurs, finds edges, closes and thresholds exactly as cv2 does', () => {
    const blurred = gaussian5(shapes, W, H)
    expect(blurred.reduce((a, b) => a + b, 0)).toBe(pieces.blur.sum)
    expect(checksum(blurred, 251)).toBe(pieces.blur.checksum)
    const edges = canny(blurred, W, H, 40, 100)
    expect(countOn(edges)).toBe(pieces.canny.count)
    expect(checksum(edges.map(v => (v > 0 ? 1 : 0)))).toBe(pieces.canny.checksum)
    const closed = closeBinary(edges, W, H)
    expect(countOn(closed)).toBe(pieces.close.count)
    expect(checksum(closed.map(v => (v > 0 ? 1 : 0)))).toBe(pieces.close.checksum)
    expect(countOn(otsuBinary(shapes))).toBe(pieces.otsu.count)
  })

  it('converts to grey with cv2 weights', () => {
    const rgba = patternRgba(40, 30)
    const gray = grayFromRgba(rgba, 40, 30)
    expect(gray.reduce((a, b) => a + b, 0)).toBe(pieces.gray.sum)
  })

  for (const [key, build] of [['contours_closed', () => closeBinary(canny(gaussian5(shapes, W, H), W, H, 40, 100), W, H)], ['contours_otsu', () => otsuBinary(shapes)]]) {
    it(`follows contours, hulls and polygon approximations like cv2 (${key})`, () => {
      const contours = findContours(build(), W, H)
      expect(contours.length).toBe(pieces[key].length)
      contours.forEach((points, i) => {
        const want = pieces[key][i]
        expect(points, `${key} #${i} points`).toEqual(want.points)
        expect(contourArea(points)).toBeCloseTo(want.area, 6)
        const hull = convexHull(points)
        expect(hull, `${key} #${i} hull`).toEqual(want.hull)
        expect(contourArea(hull)).toBeCloseTo(want.hull_area, 6)
        const perimeter = arcLengthClosed(hull)
        expect(perimeter).toBeCloseTo(want.perimeter, 3)
        for (const eps of [0.02, 0.03, 0.045, 0.06]) {
          expect(approxPolyDPClosed(hull, eps * perimeter), `${key} #${i} approx ${eps}`).toEqual(want.approx[String(eps)])
        }
        // the corner set of the rectangle (cv2 lists them in another order)
        const tidy = v => (Math.round(v * 10) / 10 + 0).toFixed(1)
        const key2 = p => p.map(([x, y]) => `${tidy(x)},${tidy(y)}`).sort().join(' ')
        expect(key2(minAreaBox(hull)), `${key} #${i} box`).toBe(key2(want.box))
      })
    })
  }

  it('equalises lightness with CLAHE exactly as cv2 does, on a width that is not a multiple of the grid', () => {
    const plane = new Uint8Array(149 * 100)
    for (let y = 0; y < 100; y++) for (let x = 0; x < 149; x++) plane[y * 149 + x] = (x * 5 + y * 3 + ((x * y) % 13) * 9) % 256
    const out = clahe8(plane, 149, 100, 2.0, 4)
    expect(out.reduce((a, b) => a + b, 0)).toBe(pieces.clahe.sum)
    expect(checksum(out, 251)).toBe(pieces.clahe.checksum)
  })

  it('converts Lab and back within one level', () => {
    const lab = pieces.lab
    const colours = []
    for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) colours.push([(x * 3) % 256, (y * 5) % 256, (x + y * 2) % 256])
    const samples = []
    const back = []
    for (let y = 0; y < 48; y += 7) {
      for (let x = 0; x < 64; x += 9) {
        const lab8 = rgbToLab8(...colours[y * 64 + x])
        samples.push(lab8)
        back.push(lab8ToRgb(...lab8))
      }
    }
    let worst = 0
    samples.forEach((v, i) => v.forEach((c, k) => { worst = Math.max(worst, Math.abs(c - lab.samples[i][k])) }))
    expect(worst).toBeLessThanOrEqual(2)
    let worstBack = 0
    back.forEach((v, i) => v.forEach((c, k) => { worstBack = Math.max(worstBack, Math.abs(c - lab.back_samples[i][k])) }))
    expect(worstBack).toBeLessThanOrEqual(3)
  })

  it('warps a quad to an upright picture like cv2.warpPerspective (cubic, replicated border)', () => {
    const photo = { data: patternRgba(200, 150), width: 200, height: 150 }
    const warp = pieces.warp
    const flat = warpCard(photo, warp.quad, warp.size)
    const worst = compareStats('warp', statsOf(flat), warp.stats)
    expect(worst).toBeLessThanOrEqual(GRID_TOLERANCE)
    let sample = 0
    let k = 0
    for (let y = 0; y < warp.size[1]; y += 17) {
      for (let x = 0; x < warp.size[0]; x += 13) {
        for (let c = 0; c < 3; c++) sample = Math.max(sample, Math.abs(flat.data[(y * warp.size[0] + x) * 4 + c] - warp.samples[Math.floor(k / 3)][c]))
        k += 3
      }
    }
    expect(sample).toBeLessThanOrEqual(1)
  })

  it('turns a card lying on its side upright', () => {
    const photo = { data: patternRgba(200, 150), width: 200, height: 150 }
    const flat = warpCard(photo, [[20, 20], [180, 25], [175, 130], [18, 125]], [126, 176])
    compareStats('warp sideways', statsOf(flat), pieces.warp_sideways.stats)
  })

  it('orders corners, measures quads and judges them like the Python helpers', () => {
    for (const item of pieces.order_corners) expect(orderCorners(item.in)).toEqual(item.out)
    for (const item of pieces.measures) {
      const measures = quadMeasures(orderCorners(item.quad), item.hull_area, item.image_area)
      for (const key of Object.keys(item.measures)) expect(measures[key], key).toBeCloseTo(item.measures[key], 2)
      expect(plausibilityProblem(item.measures, true)).toBe(item.problem_guide)
      expect(plausibilityProblem(item.measures, false)).toBe(item.problem_frame)
    }
    for (const item of pieces.guide_rect) guideRect(...item.size).forEach((v, i) => expect(v).toBeCloseTo(item.rect[i], 6))
    for (const item of pieces.is_guide_picture) expect(isGuidePicture({ width: item.size[0], height: item.size[1] }), item.size.join('x')).toBe(item.value)
    for (const item of pieces.hires_size) expect(hiresSize(item.quad)).toEqual(item.size)
  })
})

describe('findCard on generated photos (parity with detect.detect_card)', () => {
  const report = []
  for (const want of reference.cases) {
    it(`${want.name}: ${want.what}`, () => {
      const photo = decode(want.photo)
      expect([photo.width, photo.height]).toEqual(want.size)
      expect(isGuidePicture(photo)).toBe(want.is_guide_picture)
      const got = findCard(photo, { guideInput: want.guide_input, hires: true })
      // the decision is exact
      expect(got.source, 'source').toBe(want.source)
      expect(got.refused ? got.refused.reason : null, 'refusal').toBe(want.refused ? want.refused.reason : null)
      expect(Math.abs(got.confidence - want.confidence), 'confidence').toBeLessThanOrEqual(CONFIDENCE_TOLERANCE)
      let quadError = 0
      if (want.quad) {
        got.quad.forEach(([x, y], i) => { quadError = Math.max(quadError, Math.abs(x - want.quad[i][0]), Math.abs(y - want.quad[i][1])) })
        expect(quadError, 'quad corners (px)').toBeLessThanOrEqual(QUAD_TOLERANCE_PX)
      } else {
        expect(got.quad).toBeNull()
      }
      if (want.refused) {
        let refusedError = 0
        got.refused.quad.forEach(([x, y], i) => { refusedError = Math.max(refusedError, Math.abs(x - want.refused.corners[i][0]), Math.abs(y - want.refused.corners[i][1])) })
        expect(refusedError, 'refused quad corners (px)').toBeLessThanOrEqual(QUAD_TOLERANCE_PX)
        expect(got.refused.guide_picture).toBe(want.refused.guide_picture)
      }
      const worst = { card: compareStats('card', statsOf(got.card), want.card) }
      const views = cardViews(got.card)
      expect(views.map(v => v.kind)).toEqual(['card', 'card180', 'tight', 'clahe'])
      const byKind = Object.fromEntries(views.map(v => [v.kind, v.image]))
      worst.card180 = compareStats('card180', statsOf(byKind.card180), want.views.card180)
      worst.tight = compareStats('tight', statsOf(byKind.tight), want.views.tight)
      worst.clahe = compareStats('clahe', statsOf(byKind.clahe), want.views.clahe, CLAHE_GRID_TOLERANCE)
      worst.art = compareStats('art', statsOf(artCrop(got.card)), want.views.art)
      worst.artTight = compareStats('art tight', statsOf(artCrop(byKind.tight)), want.views.art_tight)
      worst.artClahe = compareStats('art clahe', statsOf(artCrop(byKind.clahe)), want.views.art_clahe, CLAHE_GRID_TOLERANCE)
      expect(Boolean(got.hires), 'sharper copy present').toBe(Boolean(want.hires))
      if (want.hires) worst.hires = compareStats('hires', statsOf(got.hires), want.hires)
      const whole = wholeDetection(photo)
      worst.whole = compareStats('whole card', statsOf(whole.card), want.whole_card)
      expect(Boolean(whole.hires)).toBe(Boolean(want.whole_hires))
      if (want.whole_hires) {
        worst.wholeHires = compareStats('whole hires', statsOf(whole.hires), want.whole_hires)
        expect(wholeCard(photo).width).toBe(whole.hires.width)
      } else {
        expect(wholeCard(photo).width).toBe(630)
      }
      report.push({ name: want.name, source: got.source, quadError, ...worst })
    })
  }
  it('reports the worst differences', () => {
    expect(report.length).toBe(reference.cases.length)
    expect(augmentedViews).toBeTypeOf('function')
  })
})
