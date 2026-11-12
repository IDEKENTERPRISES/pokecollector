// RapidOCR's text detection around the PP-OCRv4 detector, in JavaScript: the input tensor (letterbox, size limit, rounding,
// bilinear resize, ImageNet normalisation of the BGR picture) and the DB post-processing (binarise, 2x2 dilation, connected
// regions, minimum-area rectangles, box score, unclip, minimum size, box order). The detector itself is run by the caller.
// Mirrors rapidocr_onnxruntime 1.3.24 (ch_ppocr_v3_det/utils.py and text_detect.py, main.py) as ``OcrReader`` calls it:
// det_limit_type "max", det_limit_side_len set per read, thresh 0.3, unclip_ratio 1.6, use_dilation, score_mode "fast",
// max_candidates 1000, box_thresh 0.5 (0.35 for the "low" reads).
import { padRows, resizeLinear, roundHalfEven } from './image'

export const DET_THRESH = 0.3
export const UNCLIP_RATIO = 1.6
export const MAX_CANDIDATES = 1000
export const MIN_SIZE = 3
export const MIN_HEIGHT = 30 // Global.min_height
export const WIDTH_HEIGHT_RATIO = 8 // Global.width_height_ratio
const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

/**
 * Picture -> the detector's input. RapidOCR works on BGR pictures and normalises them with the RGB-ordered mean and std as
 * they are, so the channel planes go in blue, green, red. Returns {tensor: {data, dims}, image (the letterboxed picture), pad}.
 */
export function detectionInput(img, limitSide) {
  let pad = 0
  let picture = img
  const useLimit = img.width / img.height > WIDTH_HEIGHT_RATIO
  if (img.height <= MIN_HEIGHT || useLimit) {
    const newHeight = Math.max(Math.trunc(img.width / WIDTH_HEIGHT_RATIO), MIN_HEIGHT) * 2
    pad = Math.trunc(Math.abs(newHeight - img.height) / 2)
    picture = padRows(img, pad)
  }
  const { width: w, height: h } = picture
  let ratio = 1.0
  if (Math.max(h, w) > limitSide) ratio = h > w ? limitSide / h : limitSide / w
  const rh = roundHalfEven(Math.trunc(h * ratio) / 32) * 32
  const rw = roundHalfEven(Math.trunc(w * ratio) / 32) * 32
  if (rw <= 0 || rh <= 0) return null
  const resized = resizeLinear(picture, rw, rh)
  const plane = rw * rh
  const data = new Float32Array(3 * plane)
  const scale = 1 / 255
  for (let i = 0; i < plane; i++) {
    const p = i * 4
    data[i] = (Math.fround(resized.data[p + 2] * scale) - MEAN[0]) / STD[0] // blue first (BGR)
    data[plane + i] = (Math.fround(resized.data[p + 1] * scale) - MEAN[1]) / STD[1]
    data[2 * plane + i] = (Math.fround(resized.data[p] * scale) - MEAN[2]) / STD[2]
  }
  return { tensor: { data, dims: [1, 3, rh, rw] }, image: picture, pad }
}

/** The detector's output as {data, width, height}: accepts an ONNX tensor ({data, dims [1, 1, H, W]}) or that shape already. */
export function normaliseMap(map) {
  if (map.width && map.height) return map
  const dims = map.dims
  return { data: map.data, height: dims[dims.length - 2], width: dims[dims.length - 1] }
}

// ── geometry ─────────────────────────────────────────────────────────────────

function convexHull(points) {
  const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (sorted.length <= 2) return sorted
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper = []
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/** cv2.minAreaRect: the smallest rotated rectangle around the points: {corners (four points), width, height}. */
export function minAreaRect(points) {
  const hull = convexHull(points)
  if (hull.length === 0) return { corners: [[0, 0], [0, 0], [0, 0], [0, 0]], width: 0, height: 0 }
  if (hull.length <= 2) {
    const a = hull[0]
    const b = hull[hull.length - 1]
    return { corners: [a, b, b, a], width: Math.hypot(b[0] - a[0], b[1] - a[1]), height: 0 }
  }
  let best = null
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]
    const b = hull[(i + 1) % hull.length]
    const length = Math.hypot(b[0] - a[0], b[1] - a[1])
    if (length === 0) continue
    const ux = (b[0] - a[0]) / length
    const uy = (b[1] - a[1]) / length
    let minU = Infinity
    let maxU = -Infinity
    let minV = Infinity
    let maxV = -Infinity
    for (const p of hull) {
      const u = (p[0] - a[0]) * ux + (p[1] - a[1]) * uy
      const v = -(p[0] - a[0]) * uy + (p[1] - a[1]) * ux
      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }
    const area = (maxU - minU) * (maxV - minV)
    if (best === null || area < best.area - 1e-9) best = { area, a, ux, uy, minU, maxU, minV, maxV }
  }
  const { a, ux, uy, minU, maxU, minV, maxV } = best
  const at = (u, v) => [a[0] + u * ux - v * uy, a[1] + u * uy + v * ux]
  return { corners: [at(minU, minV), at(maxU, minV), at(maxU, maxV), at(minU, maxV)], width: maxU - minU, height: maxV - minV }
}

/** get_mini_boxes: the rectangle's corners as top-left, top-right, bottom-right, bottom-left, and its shorter side. */
function miniBox(points) {
  const rect = minAreaRect(points)
  const sorted = rect.corners.slice().sort((p, q) => p[0] - q[0])
  const [i1, i4] = sorted[1][1] > sorted[0][1] ? [0, 1] : [1, 0]
  const [i2, i3] = sorted[3][1] > sorted[2][1] ? [2, 3] : [3, 2]
  return { box: [sorted[i1], sorted[i2], sorted[i3], sorted[i4]], side: Math.min(rect.width, rect.height) }
}

/** The offset of a four-point polygon with round joins (pyclipper JT_ROUND): integer vertices, the arc points around each corner. */
function unclipBox(box) {
  const area = Math.abs(box.reduce((sum, p, i) => { const q = box[(i + 1) % 4]; return sum + (p[0] * q[1] - q[0] * p[1]) }, 0)) / 2
  const length = box.reduce((sum, p, i) => { const q = box[(i + 1) % 4]; return sum + Math.hypot(q[0] - p[0], q[1] - p[1]) }, 0)
  const distance = area * UNCLIP_RATIO / length
  const poly = box.map(p => [Math.trunc(p[0]), Math.trunc(p[1])]) // pyclipper takes the integer part of each coordinate
  const steps = Math.PI / Math.acos(1 - Math.min(0.25, distance * 0.25) / distance)
  const angleStep = 2 * Math.PI / steps
  const out = []
  const clipperRound = v => (v < 0 ? Math.ceil(v - 0.5) : Math.floor(v + 0.5))
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const prev = poly[(i + n - 1) % n]
    const cur = poly[i]
    const next = poly[(i + 1) % n]
    const norm = (p, q) => { const dx = q[0] - p[0]; const dy = q[1] - p[1]; const len = Math.hypot(dx, dy) || 1; return [dy / len, -dx / len] }
    const n1 = norm(prev, cur)
    const n2 = norm(cur, next)
    const a1 = Math.atan2(n1[1], n1[0])
    let a2 = Math.atan2(n2[1], n2[0])
    while (a2 < a1) a2 += 2 * Math.PI
    for (let a = a1; a < a2; a += angleStep) out.push([clipperRound(cur[0] + Math.cos(a) * distance), clipperRound(cur[1] + Math.sin(a) * distance)])
    out.push([clipperRound(cur[0] + n2[0] * distance), clipperRound(cur[1] + n2[1] * distance)])
  }
  return out
}

/** Mean of the map over the filled four-point polygon (cv2.fillPoly mask, then cv2.mean), box_score_fast. */
function boxScoreFast(map, box) {
  const { data, width, height } = map
  const clip = (v, hi) => Math.min(Math.max(v, 0), hi)
  const xmin = clip(Math.floor(Math.min(...box.map(p => p[0]))), width - 1)
  const xmax = clip(Math.ceil(Math.max(...box.map(p => p[0]))), width - 1)
  const ymin = clip(Math.floor(Math.min(...box.map(p => p[1]))), height - 1)
  const ymax = clip(Math.ceil(Math.max(...box.map(p => p[1]))), height - 1)
  const w = xmax - xmin + 1
  const h = ymax - ymin + 1
  const mask = new Uint8Array(w * h)
  const pts = box.map(p => [Math.trunc(p[0] - xmin), Math.trunc(p[1] - ymin)])
  for (let y = 0; y < h; y++) { // scanlines between the edges
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < 4; i++) {
      const p = pts[i]
      const q = pts[(i + 1) % 4]
      if ((y < Math.min(p[1], q[1])) || (y > Math.max(p[1], q[1]))) continue
      if (p[1] === q[1]) { lo = Math.min(lo, p[0], q[0]); hi = Math.max(hi, p[0], q[0]); continue }
      const x = p[0] + (q[0] - p[0]) * (y - p[1]) / (q[1] - p[1])
      lo = Math.min(lo, x)
      hi = Math.max(hi, x)
    }
    if (lo > hi) continue
    for (let x = Math.max(0, Math.floor(lo + 0.5)); x <= Math.min(w - 1, Math.floor(hi + 0.5)); x++) mask[y * w + x] = 1
  }
  for (let i = 0; i < 4; i++) { // the outline is drawn too
    let [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % 4]
    const dx = Math.abs(x1 - x0)
    const dy = Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx - dy
    for (;;) {
      if (x0 >= 0 && x0 < w && y0 >= 0 && y0 < h) mask[y0 * w + x0] = 1
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 > -dy) { err -= dy; x0 += sx }
      if (e2 < dx) { err += dx; y0 += sy }
    }
  }
  let sum = 0
  let count = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) { sum += data[(ymin + y) * width + xmin + x]; count++ }
    }
  }
  return count ? sum / count : 0
}

/** The 8-connected regions of a binary map as lists of their per-row extreme pixels (what decides each region's hull). */
function regions(bitmap, width, height) {
  const seen = new Uint8Array(width * height)
  const out = []
  const stack = []
  for (let start = 0; start < width * height; start++) {
    if (!bitmap[start] || seen[start]) continue
    const rows = new Map()
    seen[start] = 1
    stack.push(start)
    while (stack.length) {
      const index = stack.pop()
      const x = index % width
      const y = (index - x) / width
      const row = rows.get(y)
      if (!row) rows.set(y, [x, x])
      else { if (x < row[0]) row[0] = x; if (x > row[1]) row[1] = x }
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= width) continue
          const next = yy * width + xx
          if (bitmap[next] && !seen[next]) { seen[next] = 1; stack.push(next) }
        }
      }
    }
    const points = []
    for (const [y, [lo, hi]] of rows) { points.push([lo, y]); if (hi !== lo) points.push([hi, y]) }
    out.push(points)
  }
  return out
}

/**
 * The DB post-processing and RapidOCR's box filtering and ordering. ``map`` is the detector's probability map;
 * ``width``/``height`` the size of the (letterboxed) picture the boxes are drawn in. Returns [{points: 4 x [x, y] integers,
 * score}] ordered top to bottom, left to right (sorted_boxes).
 */
export function detectBoxes(rawMap, width, height, { boxThresh = 0.5, thresh = DET_THRESH } = {}) {
  const map = normaliseMap(rawMap)
  const mw = map.width
  const mh = map.height
  const mask = new Uint8Array(mw * mh)
  for (let i = 0; i < mask.length; i++) mask[i] = map.data[i] > thresh ? 1 : 0
  const dilated = new Uint8Array(mw * mh) // cv2.dilate with a 2x2 kernel of ones, anchored at its (1, 1) element
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      dilated[y * mw + x] = mask[y * mw + x] | (x > 0 ? mask[y * mw + x - 1] : 0) | (y > 0 ? mask[(y - 1) * mw + x] : 0) | (x > 0 && y > 0 ? mask[(y - 1) * mw + x - 1] : 0)
    }
  }
  const found = []
  for (const points of regions(dilated, mw, mh).slice(0, MAX_CANDIDATES)) {
    const { box: mini, side } = miniBox(points)
    if (side < MIN_SIZE) continue
    const score = boxScoreFast(map, mini)
    if (boxThresh > score) continue
    const { box, side: side2 } = miniBox(unclipBox(mini))
    if (side2 < MIN_SIZE + 2) continue
    const scaled = box.map(p => [
      Math.trunc(Math.min(Math.max(roundHalfEven(p[0] / mw * width), 0), width)),
      Math.trunc(Math.min(Math.max(roundHalfEven(p[1] / mh * height), 0), height)),
    ])
    const ordered = orderClockwise(scaled).map(p => [Math.trunc(Math.min(Math.max(p[0], 0), width - 1)), Math.trunc(Math.min(Math.max(p[1], 0), height - 1))])
    const rectWidth = Math.trunc(Math.hypot(ordered[0][0] - ordered[1][0], ordered[0][1] - ordered[1][1]))
    const rectHeight = Math.trunc(Math.hypot(ordered[0][0] - ordered[3][0], ordered[0][1] - ordered[3][1]))
    if (rectWidth <= 3 || rectHeight <= 3) continue
    found.push({ points: ordered, score })
  }
  return sortBoxes(found)
}

/** order_points_clockwise: top-left, top-right, bottom-right, bottom-left. */
function orderClockwise(points) {
  const byX = points.slice().sort((a, b) => a[0] - b[0])
  const left = byX.slice(0, 2).sort((a, b) => a[1] - b[1])
  const right = byX.slice(2).sort((a, b) => a[1] - b[1])
  return [left[0], right[0], right[1], left[1]]
}

/** sorted_boxes: top to bottom by the first corner, then boxes within ten pixels of the same height left to right. */
export function sortBoxes(boxes) {
  const list = boxes.slice().sort((a, b) => a.points[0][1] - b.points[0][1] || a.points[0][0] - b.points[0][0])
  for (let i = 0; i < list.length - 1; i++) {
    for (let j = i; j >= 0; j--) {
      if (Math.abs(list[j + 1].points[0][1] - list[j].points[0][1]) < 10 && list[j + 1].points[0][0] < list[j].points[0][0]) {
        const tmp = list[j]
        list[j] = list[j + 1]
        list[j + 1] = tmp
      } else break
    }
  }
  return list
}
