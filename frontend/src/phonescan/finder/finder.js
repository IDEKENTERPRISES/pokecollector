// The card finder of the phone matcher: a port of backend/services/card_match/detect.py (matcher version 11) over plain
// RGBA pictures {data: Uint8ClampedArray, width, height}. Pure functions, no canvas, no OpenCV.js.
import { resizeArea, resizeCubic } from '../../phonespeed/preprocess'
import { lab8ToRgb, clahe8, rgbToLab8 } from './color'
import {
  approxPolyDPClosed, arcLengthClosed, canny, closeBinary, contourArea, convexHull, findContours, gaussian5, gaussian7Float,
  grayFromRgba, median8, minAreaBox, otsuBinary, perspectiveTransform, warpPerspectiveCubic,
} from './cv'

export const CARD_W = 630
export const CARD_H = 880
export const HIRES_W = 1008
export const HIRES_H = 1408
export const CARD_RATIO = 63 / 88
export const DETECT_MAX_SIDE = 900
export const GUIDE_WIDTH_FRACTION = 0.7
export const MIN_CARD_AREA_FRACTION = 0.12
export const MIN_CONFIDENCE = 0.45
export const FALLBACK_CONFIDENCE = 0.2
export const GUIDE_PICTURE_TOLERANCE = 0.03
export const GUIDE_MIN_COVERAGE = 0.45
export const MIN_RECTANGULARITY = 0.8
export const MAX_ANGLE_DEVIATION = 35.0
export const SIDEWAYS_RATIO = 1.1
export const ART_BOX = [0.07, 0.115, 0.93, 0.545]

const f32 = Math.fround

/** Python's round(): halves go to the even neighbour. */
export function roundHalfEven(value) {
  const floor = Math.floor(value)
  const diff = value - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}
const round3 = value => Math.round(value * 1000) / 1000

// ── small picture helpers ────────────────────────────────────────────────────

function rgbToImage(rgb, width, height) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0, p = 0, q = 0; i < width * height; i++, p += 3, q += 4) {
    data[q] = rgb[p]
    data[q + 1] = rgb[p + 1]
    data[q + 2] = rgb[p + 2]
    data[q + 3] = 255
  }
  return { data, width, height }
}

/** cv2.resize(INTER_AREA) of a region (x0, y0, x1, y1 in whole pixels) of a picture. */
function areaResize(image, [x0, y0, x1, y1], dw, dh) {
  const width = x1 - x0
  const height = y1 - y0
  let source = image.data
  if (x0 !== 0 || y0 !== 0 || width !== image.width || height !== image.height) {
    source = new Uint8ClampedArray(width * height * 4)
    for (let y = 0; y < height; y++) {
      const from = ((y0 + y) * image.width + x0) * 4
      source.set(image.data.subarray(from, from + width * 4), y * width * 4)
    }
  }
  return rgbToImage(resizeArea(source, width, height, dw, dh, 4), dw, dh)
}

/** cv2.resize(INTER_CUBIC) of a region of a picture. */
function cubicResize(image, [x0, y0, x1, y1], dw, dh) {
  const width = x1 - x0
  const height = y1 - y0
  const source = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    const from = ((y0 + y) * image.width + x0) * 4
    source.set(image.data.subarray(from, from + width * 4), y * width * 4)
  }
  return rgbToImage(resizeCubic(source, width, height, dw, dh, 4), dw, dh)
}

export function rotate180(image) {
  const { data, width, height } = image
  const out = new Uint8ClampedArray(data.length)
  const pixels = width * height
  for (let i = 0; i < pixels; i++) {
    const to = (pixels - 1 - i) * 4
    out[to] = data[i * 4]
    out[to + 1] = data[i * 4 + 1]
    out[to + 2] = data[i * 4 + 2]
    out[to + 3] = 255
  }
  return { data: out, width, height }
}

// ── geometry (detect.py, same names) ─────────────────────────────────────────

export function guideRect(width, height) {
  let guideW = GUIDE_WIDTH_FRACTION * width
  let guideH = guideW * 88 / 63
  if (guideH > 0.96 * height) {
    guideH = 0.96 * height
    guideW = guideH * CARD_RATIO
  }
  const cx = width / 2
  const cy = height / 2
  return [cx - guideW / 2, cy - guideH / 2, cx + guideW / 2, cy + guideH / 2]
}

export function isGuidePicture({ width, height }) {
  return height > width && Math.abs(width / height - CARD_RATIO) / CARD_RATIO <= GUIDE_PICTURE_TOLERANCE
}

/** tl, tr, br, bl of four points (np.argmin / np.argmax pick the first of equals). */
export function orderCorners(points) {
  const pts = points.map(([x, y]) => [f32(x), f32(y)])
  const sums = pts.map(([x, y]) => f32(x + y))
  const diffs = pts.map(([x, y]) => f32(y - x))
  const argmin = values => values.indexOf(Math.min(...values))
  const argmax = values => values.indexOf(Math.max(...values))
  return [pts[argmin(sums)], pts[argmin(diffs)], pts[argmax(sums)], pts[argmax(diffs)]]
}

function sideLengths(quad) {
  const [tl, tr, br, bl] = quad
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
  return [d(tr, tl), d(br, tr), d(br, bl), d(bl, tl)]
}

function quadScore(quad, contourAreaValue, quadArea, imageArea, guide) {
  const [top, right, bottom, left] = sideLengths(quad)
  if (Math.min(top, right, bottom, left) < 20) return null
  const width = (top + bottom) / 2
  const height = (left + right) / 2
  const ratio = Math.min(width, height) / Math.max(width, height)
  const ratioError = Math.abs(ratio - CARD_RATIO) / CARD_RATIO
  if (ratioError > 0.22) return null
  if (Math.max(top, bottom) / Math.min(top, bottom) > 1.8 || Math.max(left, right) / Math.min(left, right) > 1.8) return null
  const areaFraction = quadArea / imageArea
  if (areaFraction < MIN_CARD_AREA_FRACTION || areaFraction > 0.97) return null
  const centreX = quad.reduce((s, p) => s + p[0], 0) / 4
  const centreY = quad.reduce((s, p) => s + p[1], 0) / 4
  const [gx0, gy0, gx1, gy1] = guide
  const gw = gx1 - gx0
  const gh = gy1 - gy0
  const drift = Math.max(Math.abs(centreX - (gx0 + gx1) / 2) / gw, Math.abs(centreY - (gy0 + gy1) / 2) / gh)
  if (drift > 0.6) return null
  const rectangularity = quadArea > 0 ? Math.min(1, contourAreaValue / quadArea) : 0
  const guideArea = gw * gh
  const fill = Math.min(quadArea / guideArea, guideArea / quadArea)
  return 0.35 * (1 - Math.min(1, ratioError / 0.22)) + 0.3 * rectangularity + 0.2 * fill + 0.15 * (1 - Math.min(1, drift / 0.6))
}

function angleDeviation(quad) {
  let worst = 0
  for (let i = 0; i < 4; i++) {
    const a = quad[(i + 3) % 4]
    const b = quad[i]
    const c = quad[(i + 1) % 4]
    const u = [a[0] - b[0], a[1] - b[1]]
    const v = [c[0] - b[0], c[1] - b[1]]
    const denom = Math.hypot(...u) * Math.hypot(...v)
    if (denom <= 0) return 90
    const cos = Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / denom))
    worst = Math.max(worst, Math.abs(Math.acos(cos) * 180 / Math.PI - 90))
  }
  return worst
}

export function quadMeasures(quad, hullArea, imageArea) {
  const [top, right, bottom, left] = sideLengths(quad)
  const width = (top + bottom) / 2
  const height = (left + right) / 2
  const area = contourArea(quad)
  const ratio = Math.max(width, height) > 0 ? Math.min(width, height) / Math.max(width, height) : 0
  return {
    coverage: imageArea ? round3(area / imageArea) : 0,
    ratio_error: round3(Math.abs(ratio - CARD_RATIO) / CARD_RATIO),
    rectangularity: area > 0 && hullArea > 0 ? round3(Math.min(area, hullArea) / Math.max(area, hullArea)) : 0,
    angle_deviation: Math.round(angleDeviation(quad) * 10) / 10,
    wide_over_tall: height > 0 ? round3(width / height) : 0,
  }
}

export function plausibilityProblem(measures, guideInput) {
  if (measures.rectangularity < MIN_RECTANGULARITY) return 'not_rectangular'
  if (measures.angle_deviation > MAX_ANGLE_DEVIATION) return 'bad_angles'
  if (!guideInput) return null
  if (measures.wide_over_tall > SIDEWAYS_RATIO) return 'sideways'
  if (measures.coverage < GUIDE_MIN_COVERAGE) return 'too_small'
  return null
}

// ── edge maps and the quad search ────────────────────────────────────────────

export function edgeMaps(small) {
  const { width, height } = small
  const gray = grayFromRgba(small.data, width, height)
  const blurred = gaussian5(gray, width, height)
  const counts = new Float64Array(256)
  for (let i = 0; i < blurred.length; i++) counts[blurred[i]]++
  const median = median8(counts, blurred.length)
  const low = Math.trunc(Math.max(0, 0.66 * median))
  const high = Math.trunc(Math.min(255, 1.33 * median + 20))
  const edges = closeBinary(canny(blurred, width, height, low, Math.max(high, low + 30)), width, height)

  // colour distance from the photo's border colour
  const L = new Uint8Array(width * height)
  const A = new Uint8Array(width * height)
  const B = new Uint8Array(width * height)
  const d = small.data
  for (let i = 0; i < width * height; i++) {
    const [l, a, b] = rgbToLab8(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])
    L[i] = l
    A[i] = a
    B[i] = b
  }
  const border = [new Float64Array(256), new Float64Array(256), new Float64Array(256)]
  let total = 0
  const add = i => {
    border[0][L[i]]++
    border[1][A[i]]++
    border[2][B[i]]++
    total++
  }
  const rows = Math.min(6, height)
  const cols = Math.min(6, width)
  for (let y = 0; y < rows; y++) for (let x = 0; x < width; x++) add(y * width + x)
  for (let y = height - rows; y < height; y++) for (let x = 0; x < width; x++) add(y * width + x)
  for (let y = 0; y < height; y++) for (let x = 0; x < cols; x++) add(y * width + x)
  for (let y = 0; y < height; y++) for (let x = width - cols; x < width; x++) add(y * width + x)
  const med = border.map(counts8 => median8(counts8, total))
  const distance = new Float32Array(width * height)
  for (let i = 0; i < distance.length; i++) {
    const dl = f32(L[i] - med[0])
    const da = f32(A[i] - med[1])
    const db = f32(B[i] - med[2])
    distance[i] = f32(Math.sqrt(f32(f32(dl * dl) + f32(da * da)) + f32(db * db)))
  }
  const blurredDistance = gaussian7Float(distance, width, height)
  const scaled = new Uint8Array(width * height)
  for (let i = 0; i < scaled.length; i++) scaled[i] = Math.max(0, Math.min(255, f32(blurredDistance[i] * 4)))
  const mask = closeBinary(otsuBinary(scaled), width, height)
  return [edges, mask]
}

/** The best card-like quad of a (shrunk) picture: {quad (tl,tr,br,bl), score} or null; refused quads are pushed to `rejections`. */
export function findQuad(small, guide, { check = false, guideInput = false, rejections = null } = {}) {
  const { width, height } = small
  const imageArea = width * height
  let best = null
  for (const edges of edgeMaps(small)) {
    const contours = findContours(edges, width, height)
    const ranked = contours.map(points => ({ points, area: contourArea(points) })).sort((a, b) => b.area - a.area).slice(0, 8)
    for (const { points, area } of ranked) {
      if (area < MIN_CARD_AREA_FRACTION * imageArea * 0.7) break
      const hull = convexHull(points)
      const perimeter = arcLengthClosed(hull)
      let quad = null
      for (const epsilon of [0.02, 0.03, 0.045, 0.06]) {
        const approx = approxPolyDPClosed(hull, epsilon * perimeter)
        if (approx.length === 4) {
          quad = approx
          break
        }
      }
      if (quad === null) quad = minAreaBox(hull)
      const ordered = orderCorners(quad)
      const hullArea = contourArea(hull)
      const score = quadScore(ordered, hullArea, contourArea(ordered), imageArea, guide)
      if (score !== null && check) {
        const measures = quadMeasures(ordered, hullArea, imageArea)
        const problem = plausibilityProblem(measures, guideInput)
        if (problem) {
          if (rejections) rejections.push({ reason: problem, ...measures, score: round3(score), corners: ordered })
          continue
        }
      }
      if (score !== null && (best === null || score > best.score)) best = { quad: ordered, score }
    }
  }
  return best
}

// ── flattening ───────────────────────────────────────────────────────────────

/** Flatten the quad (tl, tr, br, bl) to an upright RGBA picture of `size`. */
export function warpCard(photo, corners, size = [CARD_W, CARD_H]) {
  const [width, height] = size
  const [top, right, bottom, left] = sideLengths(corners)
  let quad = corners
  if (top + bottom > left + right) quad = [corners[3], corners[0], corners[1], corners[2]]
  const target = [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]]
  const matrix = perspectiveTransform(quad, target)
  return { data: warpPerspectiveCubic(photo.data, photo.width, photo.height, matrix, width, height), width, height }
}

export function hiresSize(corners) {
  const [top, right, bottom, left] = sideLengths(corners)
  const longSide = Math.max((left + right) / 2, (top + bottom) / 2)
  if (longSide < 1.1 * CARD_H) return null
  const height = Math.trunc(Math.min(HIRES_H, roundHalfEven(longSide)))
  return [roundHalfEven(height * CARD_RATIO), height]
}

export function guideCrop(photo) {
  const { width, height } = photo
  const [x0, y0, x1, y1] = guideRect(width, height).map(roundHalfEven)
  return areaResize(photo, [Math.max(0, x0), Math.max(0, y0), Math.min(width, x1), Math.min(height, y1)], CARD_W, CARD_H)
}

export function wholePicture(photo) {
  return areaResize(photo, [0, 0, photo.width, photo.height], CARD_W, CARD_H)
}

function sharperCopy(photo, rect) {
  const { width, height } = photo
  const [x0, y0, x1, y1] = rect.map(roundHalfEven)
  const box = [Math.max(0, x0), Math.max(0, y0), Math.min(width, x1), Math.min(height, y1)]
  const cropH = box[3] - box[1]
  if (box[2] - box[0] <= 0 || cropH <= 0 || cropH < 1.1 * CARD_H) return null
  const target = Math.min(HIRES_H, cropH)
  return areaResize(photo, box, roundHalfEven(target * CARD_RATIO), target)
}

/** detect.whole_detection: the whole picture as the card, with its sharper copy. */
export function wholeDetection(photo) {
  return { card: wholePicture(photo), hires: sharperCopy(photo, [0, 0, photo.width, photo.height]) }
}

/** The picture the whole-picture second read uses: the sharper copy when the photo has one, else the 630x880 card. */
export function wholeCard(photo) {
  const { card, hires } = wholeDetection(photo)
  return hires || card
}

/**
 * detect.detect_card(photo, check=True, whole=True): the card of a photo, flattened to 630x880.
 *   guideInput: null/undefined = judge by the picture's shape (isGuidePicture); false = a whole camera frame; true = a guide crop.
 *   hires: also build the sharper flat copy the text is read from (up to 1008x1408; costs time).
 *   detectMaxSide: the long side of the copy the quad is searched on (default 900, the server's DETECT_MAX_SIDE, which parity needs). A smaller
 *     value is faster and can move the corners a little; the warp always comes from the full-size photo. See docs/phone-scanner/integration.md.
 * Returns {card, source: 'quad' | 'guide' | 'whole', quad | null (in photo pixels, tl,tr,br,bl), refused: {reason, quad, ...} | null,
 *          confidence, hires | null}.
 */
export function findCard(photo, { guideInput = null, hires = false, detectMaxSide = DETECT_MAX_SIDE } = {}) {
  const { width: w, height: h } = photo
  const scale = Math.min(1, detectMaxSide / Math.max(h, w))
  let small = photo
  if (scale < 1) {
    const sw = Math.max(1, roundHalfEven(w * scale))
    const sh = Math.max(1, roundHalfEven(h * scale))
    small = rgbToImage(resizeArea(photo.data, w, h, sw, sh, 4), sw, sh)
  }
  const guideBox = guideRect(small.width, small.height)
  const isGuide = guideInput === null || guideInput === undefined ? isGuidePicture(photo) : Boolean(guideInput)
  const rejections = []
  const found = findQuad(small, guideBox, { check: true, guideInput: isGuide, rejections })
  if (found && found.score >= MIN_CONFIDENCE) {
    const quad = found.quad.map(([x, y]) => [f32(x / scale), f32(y / scale)])
    const size = hiresSize(quad)
    return {
      card: warpCard(photo, quad), source: 'quad', quad, refused: null, confidence: round3(found.score),
      hires: hires && size ? warpCard(photo, quad, size) : null,
    }
  }
  let refused = null
  if (rejections.length) {
    let best = rejections[0]
    for (const item of rejections) if (item.score > best.score) best = item
    refused = { ...best, quad: best.corners.map(([x, y]) => [Math.round(x / scale * 10) / 10, Math.round(y / scale * 10) / 10]), guide_picture: isGuide }
    delete refused.corners
  }
  if (isGuide) {
    return { card: wholePicture(photo), source: 'whole', quad: null, refused, confidence: FALLBACK_CONFIDENCE, hires: hires ? sharperCopy(photo, [0, 0, w, h]) : null }
  }
  return {
    card: guideCrop(photo), source: 'guide', quad: null, refused, confidence: FALLBACK_CONFIDENCE,
    hires: hires && refused ? sharperCopy(photo, guideRect(w, h)) : null,
  }
}

// ── the views the matcher embeds ─────────────────────────────────────────────

/** detect.art_crop: the artwork window of an upright flat card. */
export function artCrop(card) {
  const { data, width, height } = card
  const [x0, y0, x1, y1] = ART_BOX
  const left = Math.trunc(x0 * width)
  const top = Math.trunc(y0 * height)
  const right = Math.trunc(x1 * width)
  const bottom = Math.trunc(y1 * height)
  const w = right - left
  const h = bottom - top
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const from = ((top + y) * width + left) * 4
    out.set(data.subarray(from, from + w * 4), y * w * 4)
  }
  return { data: out, width: w, height: h }
}

/** detect.augmented_views: a 3.5% tighter centre crop stretched back to the card size, and the CLAHE lightness copy. */
export function augmentedViews(card) {
  const { width, height } = card
  const mx = Math.trunc(0.035 * width)
  const my = Math.trunc(0.035 * height)
  const tight = cubicResize(card, [mx, my, width - mx, height - my], width, height)
  const planeL = new Uint8Array(width * height)
  const planeA = new Uint8Array(width * height)
  const planeB = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const [l, a, b] = rgbToLab8(card.data[i * 4], card.data[i * 4 + 1], card.data[i * 4 + 2])
    planeL[i] = l
    planeA[i] = a
    planeB[i] = b
  }
  const equalised = clahe8(planeL, width, height, 2.0, 4)
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const [r, g, b] = lab8ToRgb(equalised[i], planeA[i], planeB[i])
    data[i * 4] = r
    data[i * 4 + 1] = g
    data[i * 4 + 2] = b
    data[i * 4 + 3] = 255
  }
  return [tight, { data, width, height }]
}

/**
 * The pictures the in-use option set embeds for a flat card, in the server's order (pipeline._main_scores then
 * _picture_scores): the card, the card turned 180 degrees, then the two augmented views of the card. The server builds
 * those two from the card the right way up (the card itself, or its 180 degree copy when the turned view scored clearly
 * higher); call `augmentedViews(rotate180(card))` for that case. The artwork pictures are `artCrop` of the card and of
 * both augmented views.
 */
export function cardViews(card) {
  const [tight, clahe] = augmentedViews(card)
  return [
    { kind: 'card', image: card },
    { kind: 'card180', image: rotate180(card) },
    { kind: 'tight', image: tight },
    { kind: 'clahe', image: clahe },
  ]
}
