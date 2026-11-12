// The OpenCV routines backend/services/card_match/detect.py uses, written out in plain JavaScript (no OpenCV.js; see
// docs/phone-scanner/finder.md for why). Each one follows OpenCV 4.10.0's own algorithm (the version the server pins), so
// the same input gives the same output except where noted: contours, hulls and polygon approximations are exact ports;
// the colour conversions and the warp round a little differently (at most one 8-bit level).

// ── grey, blur, edges ────────────────────────────────────────────────────────

/** cv2.cvtColor(..., COLOR_BGR2GRAY) on an RGBA picture: OpenCV's 14-bit fixed-point weights. */
export function grayFromRgba(rgba, width, height) {
  const out = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (rgba[p] * 4899 + rgba[p + 1] * 9617 + rgba[p + 2] * 1868 + 8192) >> 14
  }
  return out
}

const reflect101 = (i, n) => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i)

/** cv2.GaussianBlur(gray, (5, 5), 0): the kernel 1 4 6 4 1 per axis, rounded once at the end (OpenCV's exact fixed point). */
export function gaussian5(gray, width, height) {
  const tmp = new Int32Array(width * height)
  const w = [1, 4, 6, 4, 1]
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let s = 0
      for (let k = -2; k <= 2; k++) s += w[k + 2] * gray[row + reflect101(x + k, width)]
      tmp[row + x] = s
    }
  }
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0
      for (let k = -2; k <= 2; k++) s += w[k + 2] * tmp[reflect101(y + k, height) * width + x]
      out[y * width + x] = (s + 128) >> 8
    }
  }
  return out
}

const GAUSS7 = [0.03125, 0.109375, 0.21875, 0.28125, 0.21875, 0.109375, 0.03125]

/** cv2.GaussianBlur(float32 picture, (7, 7), 0): OpenCV's fixed 7-tap kernel. */
export function gaussian7Float(values, width, height) {
  const tmp = new Float64Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let s = 0
      for (let k = -3; k <= 3; k++) s += GAUSS7[k + 3] * values[row + reflect101(x + k, width)]
      tmp[row + x] = Math.fround(s)
    }
  }
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0
      for (let k = -3; k <= 3; k++) s += GAUSS7[k + 3] * tmp[reflect101(y + k, height) * width + x]
      out[y * width + x] = s
    }
  }
  return out
}

/** np.median of 8-bit values (the mean of the two middle ones for an even count). */
export function median8(counts, total) {
  const at = target => {
    let seen = 0
    for (let v = 0; v < 256; v++) {
      seen += counts[v]
      if (seen > target) return v
    }
    return 255
  }
  return total % 2 ? at((total - 1) / 2) : (at(total / 2 - 1) + at(total / 2)) / 2
}

/** cv2.Canny(gray, low, high) with a 3x3 Sobel and the L1 gradient: OpenCV's non-maximum suppression and hysteresis. */
export function canny(gray, width, height, low, high) {
  if (low > high) [low, high] = [high, low]
  const dx = new Int16Array(width * height)
  const dy = new Int16Array(width * height)
  const at = (x, y) => gray[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = at(x - 1, y - 1), b = at(x, y - 1), c = at(x + 1, y - 1)
      const d = at(x - 1, y), f = at(x + 1, y)
      const g = at(x - 1, y + 1), h = at(x, y + 1), i = at(x + 1, y + 1)
      dx[y * width + x] = (c - a) + 2 * (f - d) + (i - g)
      dy[y * width + x] = (g - a) + 2 * (h - b) + (i - c)
    }
  }
  const mag = new Int32Array(width * height)
  for (let i = 0; i < mag.length; i++) mag[i] = Math.abs(dx[i]) + Math.abs(dy[i])
  const magAt = (x, y) => (x < 0 || x >= width || y < 0 || y >= height ? 0 : mag[y * width + x])
  const mapW = width + 2
  const map = new Uint8Array(mapW * (height + 2)).fill(1) // 1 = not an edge, 0 = candidate, 2 = edge
  const stack = []
  const TG22 = 13573
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const m = mag[y * width + x]
      const slot = (y + 1) * mapW + x + 1
      if (m <= low) continue
      const xs = dx[y * width + x]
      const ys = dy[y * width + x]
      const ax = Math.abs(xs)
      const ay = Math.abs(ys) * 32768
      const tg22x = ax * TG22
      let keep = false
      if (ay < tg22x) {
        keep = m > magAt(x - 1, y) && m >= magAt(x + 1, y)
      } else {
        const tg67x = tg22x + ax * 65536
        if (ay > tg67x) {
          keep = m > magAt(x, y - 1) && m >= magAt(x, y + 1)
        } else {
          const s = (xs ^ ys) < 0 ? -1 : 1
          keep = m > magAt(x - s, y - 1) && m > magAt(x + s, y + 1)
        }
      }
      if (!keep) continue
      if (m > high) {
        map[slot] = 2
        stack.push(slot)
      } else {
        map[slot] = 0
      }
    }
  }
  const neighbours = [-mapW - 1, -mapW, -mapW + 1, -1, 1, mapW - 1, mapW, mapW + 1]
  while (stack.length) {
    const m = stack.pop()
    for (const d of neighbours) {
      if (map[m + d] === 0) {
        map[m + d] = 2
        stack.push(m + d)
      }
    }
  }
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out[y * width + x] = map[(y + 1) * mapW + x + 1] === 2 ? 255 : 0
  }
  return out
}

/** cv2.morphologyEx(MORPH_CLOSE, 5x5 rectangle, iterations=2) on a 0/255 picture: a 9x9 dilation then a 9x9 erosion. */
export function closeBinary(src, width, height, radius = 4) {
  const pass = (input, horizontal, takeMax) => {
    const out = new Uint8Array(input.length)
    const length = horizontal ? width : height
    const lines = horizontal ? height : width
    for (let line = 0; line < lines; line++) {
      for (let i = 0; i < length; i++) {
        let best = takeMax ? 0 : 255
        const from = Math.max(0, i - radius)
        const to = Math.min(length - 1, i + radius)
        for (let k = from; k <= to; k++) {
          const v = horizontal ? input[line * width + k] : input[k * width + line]
          if (takeMax ? v > best : v < best) best = v
        }
        if (horizontal) out[line * width + i] = best
        else out[i * width + line] = best
      }
    }
    return out
  }
  let result = pass(pass(src, true, true), false, true)
  result = pass(pass(result, true, false), false, false)
  return result
}

/** cv2.threshold(gray, 0, 255, THRESH_BINARY + THRESH_OTSU). */
export function otsuBinary(gray) {
  const hist = new Float64Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  const scale = 1 / gray.length
  let mu = 0
  for (let i = 0; i < 256; i++) mu += i * hist[i] * scale
  let q1 = 0
  let mu1 = 0
  let maxSigma = 0
  let threshold = 0
  const EPS = 1.1920929e-7
  for (let i = 0; i < 256; i++) {
    const p = hist[i] * scale
    mu1 *= q1
    q1 += p
    const q2 = 1 - q1
    if (Math.min(q1, q2) < EPS || Math.max(q1, q2) > 1 - EPS) continue
    mu1 = (mu1 + i * p) / q1
    const mu2 = (mu - q1 * mu1) / q2
    const sigma = q1 * q2 * (mu1 - mu2) * (mu1 - mu2)
    if (sigma > maxSigma) {
      maxSigma = sigma
      threshold = i
    }
  }
  const out = new Uint8Array(gray.length)
  for (let i = 0; i < gray.length; i++) out[i] = gray[i] > threshold ? 255 : 0
  return out
}

// ── contours ─────────────────────────────────────────────────────────────────

const CHAIN = [[1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]]
const MARK_NEW = 2
const MARK_RIGHT_NEW = -126 // 0x82 as a signed byte

/** cv2.findContours(binary, RETR_LIST, CHAIN_APPROX_SIMPLE): a port of OpenCV 4.10's Suzuki border follower.
 *  Returns the contours as arrays of [x, y], in OpenCV's order (the last one found first). */
export function findContours(binary, width, height) {
  const step = width + 2
  const image = new Int8Array(step * (height + 2))
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (binary[y * width + x]) image[(y + 1) * step + x + 1] = 1
  const delta = CHAIN.map(([cx, cy]) => cx + cy * step)
  const found = []

  const fetch = (startIndex, startX, startY, isHole) => {
    const i0 = startIndex
    let sEnd = isHole ? 0 : 4
    let s = sEnd
    let i1
    do {
      s = (s - 1) & 7
      i1 = i0 + delta[s]
    } while (image[i1] === 0 && s !== sEnd)
    const pts = []
    let px = startX
    let py = startY
    if (s === sEnd) {
      image[i0] = MARK_RIGHT_NEW
      pts.push([px, py])
      return pts
    }
    let i3 = i0
    let i4 = 0
    let prevS = s ^ 4
    for (;;) {
      sEnd = s
      while (s < 15) {
        s++
        i4 = i3 + delta[s & 7]
        if (image[i4] !== 0) break
      }
      s &= 7
      if (s >= 1 && s - 1 < sEnd) image[i3] = MARK_RIGHT_NEW
      else if (image[i3] === 1) image[i3] = MARK_NEW
      if (s !== prevS) pts.push([px, py])
      prevS = s
      px += CHAIN[s][0]
      py += CHAIN[s][1]
      if (i4 === i0 && i3 === i1) break
      i3 = i4
      s = (s + 4) & 7
    }
    return pts
  }

  const last = step - 1
  for (let y = 1; y < height + 1; y++) {
    let x = 1
    let prev = 0
    while (x < last) {
      let p = 0
      while (x < last && (p = image[y * step + x]) === prev) x++
      if (x >= last) break
      let isHole = false
      let start = true
      if (!(prev === 0 && p === 1)) {
        if (p !== 0 || prev < 1) start = false
        else isHole = true
      }
      if (start) {
        const sx = x - (isHole ? 1 : 0)
        found.push(fetch(y * step + sx, sx - 1, y - 1, isHole))
        prev = image[y * step + x]
        x++
      } else {
        prev = p
        x++
      }
    }
  }
  return found.reverse()
}

/** cv2.contourArea (unsigned) of points [[x, y], ...]. */
export function contourArea(points) {
  let sum = 0
  for (let i = 0, n = points.length; i < n; i++) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[(i + 1) % n]
    sum += x0 * y1 - x1 * y0
  }
  return Math.abs(sum) / 2
}

/** cv2.arcLength(points, closed=True). */
export function arcLengthClosed(points) {
  let sum = 0
  for (let i = 0, n = points.length; i < n; i++) {
    const [x0, y0] = points[i]
    const [x1, y1] = points[(i + 1) % n]
    sum += Math.hypot(x1 - x0, y1 - y0)
  }
  return sum
}

// cv2.convexHull(points) (clockwise=False, returnPoints=True): OpenCV's Sklansky scan, including its final cyclic shift,
// so the hull starts at the same point (approxPolyDP's result depends on where it starts).
function sklansky(array, start, end, stack, nsign, sign2) {
  const incr = end > start ? 1 : -1
  let pprev = start
  let pcur = pprev + incr
  let pnext = pcur + incr
  let stacksize = 3
  if (start === end || (array[start][0] === array[end][0] && array[start][1] === array[end][1])) {
    stack[0] = start
    return 1
  }
  stack[0] = pprev
  stack[1] = pcur
  stack[2] = pnext
  end += incr
  const sign = v => (v > 0) - (v < 0)
  while (pnext !== end) {
    const cury = array[pcur][1]
    const nexty = array[pnext][1]
    const by = nexty - cury
    if (sign(by) !== nsign) {
      const ax = array[pcur][0] - array[pprev][0]
      const bx = array[pnext][0] - array[pcur][0]
      const ay = cury - array[pprev][1]
      const convexity = ay * bx - ax * by
      if (sign(convexity) === sign2 && (ax !== 0 || ay !== 0)) {
        pprev = pcur
        pcur = pnext
        pnext += incr
        stack[stacksize] = pnext
        stacksize++
      } else if (pprev === start) {
        pcur = pnext
        stack[1] = pcur
        pnext += incr
        stack[2] = pnext
      } else {
        stack[stacksize - 2] = pnext
        pcur = pprev
        pprev = stack[stacksize - 4]
        stacksize--
      }
    } else {
      pnext += incr
      stack[stacksize - 1] = pnext
    }
  }
  return --stacksize
}

export function convexHull(points) {
  const total = points.length
  if (!total) return []
  const order = points.map((_, i) => i)
  order.sort((a, b) => points[a][0] - points[b][0] || points[a][1] - points[b][1] || a - b)
  const pointer = order.map(i => points[i])
  let minY = 0
  let maxY = 0
  for (let i = 1; i < total; i++) {
    if (pointer[minY][1] > pointer[i][1]) minY = i
    if (pointer[maxY][1] < pointer[i][1]) maxY = i
  }
  const hullBuf = []
  const stack = new Array(total + 2).fill(0)
  if (pointer[0][0] === pointer[total - 1][0] && pointer[0][1] === pointer[total - 1][1]) {
    hullBuf.push(0)
  } else {
    // OpenCV keeps the four scans in one shared array; each scan only reads its own part, so separate arrays do the same.
    const run = (start, end, nsign, sign2) => {
      const stackOf = new Array(total + 2).fill(0)
      return { stackOf, count: sklansky(pointer, start, end, stackOf, nsign, sign2) }
    }
    let upperLeft = run(0, maxY, -1, 1)
    let upperRight = run(total - 1, maxY, -1, -1)
    ;[upperLeft, upperRight] = [upperRight, upperLeft] // counter-clockwise output swaps them
    const tl = upperLeft.stackOf, tlCount = upperLeft.count, tr = upperRight.stackOf, trCount = upperRight.count
    for (let i = 0; i < tlCount - 1; i++) hullBuf.push(order[tl[i]])
    for (let i = trCount - 1; i > 0; i--) hullBuf.push(order[tr[i]])
    const stopIdx = trCount > 2 ? tr[1] : tlCount > 2 ? tl[tlCount - 2] : -1
    const lowerLeft = run(0, minY, 1, -1)
    const lowerRight = run(total - 1, minY, 1, 1)
    const bl = lowerLeft.stackOf, br = lowerRight.stackOf
    let blCount = lowerLeft.count
    let brCount = lowerRight.count
    if (stopIdx >= 0) {
      const checkIdx = blCount > 2 ? bl[1] : blCount + brCount > 2 ? br[2 - blCount] : -1
      if (checkIdx === stopIdx || (checkIdx >= 0 && pointer[checkIdx][0] === pointer[stopIdx][0] && pointer[checkIdx][1] === pointer[stopIdx][1])) {
        blCount = Math.min(blCount, 2)
        brCount = Math.min(brCount, 2)
      }
    }
    for (let i = 0; i < blCount - 1; i++) hullBuf.push(order[bl[i]])
    for (let i = brCount - 1; i > 0; i--) hullBuf.push(order[br[i]])
    const nout = hullBuf.length
    if (nout >= 3) {
      let minIdx = 0
      let maxIdx = 0
      let lt = 0
      for (let i = 1; i < nout; i++) {
        const idx = hullBuf[i]
        lt += hullBuf[i - 1] < idx ? 1 : 0
        if (lt > 1 && lt <= i - 2) break
        if (idx < hullBuf[minIdx]) minIdx = i
        if (idx > hullBuf[maxIdx]) maxIdx = i
      }
      const mmdist = Math.abs(maxIdx - minIdx)
      if ((mmdist === 1 || mmdist === nout - 1) && (lt <= 1 || lt >= nout - 2)) {
        const ascending = (maxIdx + 1) % nout === minIdx
        const i0 = ascending ? minIdx : maxIdx
        let j = i0
        if (i0 > 0) {
          const shifted = []
          let i = 0
          for (; i < nout; i++) {
            const curr = hullBuf[j]
            shifted[i] = curr
            const nextJ = j + 1 < nout ? j + 1 : 0
            const next = hullBuf[nextJ]
            if (i < nout - 1 && ascending !== curr < next) break
            j = nextJ
          }
          if (i === nout) for (let k = 0; k < nout; k++) hullBuf[k] = shifted[k]
        }
      }
    }
  }
  return hullBuf.map(i => points[i])
}

/** cv2.approxPolyDP(points, epsilon, closed=True) on integer points: a line-by-line port of OpenCV 4.10. */
export function approxPolyDPClosed(src, epsilon) {
  const count0 = src.length
  const eps = epsilon * epsilon
  const dst = []
  if (count0 === 0) return dst
  let count = count0
  const stack = []
  let pos = 0
  let start = [-1000000, -1000000]
  let end = [0, 0]
  let pt = [0, 0]
  let rightStart = 0
  let slice = { start: 0, end: 0 }
  let right = { start: 0, end: 0 }
  let leEps = false
  const read = () => {
    const value = src[pos]
    if (++pos >= count) pos = 0
    return value
  }
  // 1. two roughly farthest points
  right.start = 0
  for (let i = 0; i < 3; i++) {
    let maxDist = 0
    pos = (pos + right.start) % count
    start = read()
    for (let j = 1; j < count; j++) {
      pt = read()
      const dx = pt[0] - start[0]
      const dy = pt[1] - start[1]
      const dist = dx * dx + dy * dy
      if (dist > maxDist) {
        maxDist = dist
        right.start = j
      }
    }
    leEps = maxDist <= eps
  }
  rightStart = right.start
  // 2. the stack
  if (!leEps) {
    right.end = slice.start = pos % count
    slice.end = right.start = (rightStart + slice.start) % count
    stack.push({ ...right })
    stack.push({ ...slice })
  } else {
    dst.push(start)
  }
  // 3. recurse
  while (stack.length) {
    slice = stack.pop()
    end = src[slice.end]
    pos = slice.start
    start = read()
    if (pos !== slice.end) {
      let maxDist = 0
      const dx = end[0] - start[0]
      const dy = end[1] - start[1]
      while (pos !== slice.end) {
        pt = read()
        const dist = Math.abs((pt[1] - start[1]) * dx - (pt[0] - start[0]) * dy)
        if (dist > maxDist) {
          maxDist = dist
          right.start = (pos + count - 1) % count
        }
      }
      leEps = maxDist * maxDist <= eps * (dx * dx + dy * dy)
    } else {
      leEps = true
      start = src[slice.start]
    }
    if (leEps) {
      dst.push(start)
    } else {
      right.end = slice.end
      slice.end = right.start
      stack.push({ ...right })
      stack.push({ ...slice })
    }
  }
  // clean-up of nearly straight runs
  let newCount = dst.length
  count = newCount
  pos = count - 1
  const readDst = () => {
    const value = dst[pos]
    if (++pos >= count) pos = 0
    return value
  }
  start = readDst()
  let wpos = pos
  pt = readDst()
  for (let i = 0; i < count && newCount > 2; i++) {
    end = readDst()
    const dx = end[0] - start[0]
    const dy = end[1] - start[1]
    const dist = Math.abs((pt[0] - start[0]) * dy - (pt[1] - start[1]) * dx)
    const inner = (pt[0] - start[0]) * (end[0] - pt[0]) + (pt[1] - start[1]) * (end[1] - pt[1])
    if (dist * dist <= 0.5 * eps * (dx * dx + dy * dy) && dx !== 0 && dy !== 0 && inner >= 0) {
      newCount--
      start = end
      dst[wpos] = start
      if (++wpos >= count) wpos = 0
      pt = readDst()
      i++
      continue
    }
    start = pt
    dst[wpos] = start
    if (++wpos >= count) wpos = 0
    pt = end
  }
  return dst.slice(0, newCount)
}

/** cv2.boxPoints(cv2.minAreaRect(points)) for a convex polygon: the smallest rectangle that has a side along a polygon edge. */
export function minAreaBox(hull) {
  const n = hull.length
  if (n < 3) return hull.map(p => [p[0], p[1]])
  let best = null
  for (let i = 0; i < n; i++) {
    const [x0, y0] = hull[i]
    const [x1, y1] = hull[(i + 1) % n]
    const len = Math.hypot(x1 - x0, y1 - y0)
    if (!len) continue
    const ux = (x1 - x0) / len
    const uy = (y1 - y0) / len
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
    for (const [x, y] of hull) {
      const u = x * ux + y * uy
      const v = -x * uy + y * ux
      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }
    const area = (maxU - minU) * (maxV - minV)
    if (!best || area <= best.area) best = { area, ux, uy, minU, maxU, minV, maxV }
  }
  if (!best) return hull.map(p => [p[0], p[1]])
  const { ux, uy, minU, maxU, minV, maxV } = best
  const corner = (u, v) => [u * ux - v * uy, u * uy + v * ux]
  return [corner(minU, minV), corner(maxU, minV), corner(maxU, maxV), corner(minU, maxV)].map(p => [Math.fround(p[0]), Math.fround(p[1])])
}

// ── perspective ──────────────────────────────────────────────────────────────

/** cv2.getPerspectiveTransform(src4, dst4): the 3x3 matrix (row-major, last entry 1). */
export function perspectiveTransform(src, dst) {
  const a = []
  const b = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]
    const [u, v] = dst[i]
    a.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u)
    a.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v)
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col
    for (let r = col + 1; r < 8; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r
    ;[a[col], a[pivot]] = [a[pivot], a[col]]
    ;[b[col], b[pivot]] = [b[pivot], b[col]]
    for (let r = col + 1; r < 8; r++) {
      const f = a[r][col] / a[col][col]
      for (let c = col; c < 8; c++) a[r][c] -= f * a[col][c]
      b[r] -= f * b[col]
    }
  }
  const x = new Array(8).fill(0)
  for (let r = 7; r >= 0; r--) {
    let s = b[r]
    for (let c = r + 1; c < 8; c++) s -= a[r][c] * x[c]
    x[r] = s / a[r][r]
  }
  return [...x, 1]
}

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  const k = 1 / det
  return [
    (e * i - f * h) * k, (c * h - b * i) * k, (b * f - c * e) * k,
    (f * g - d * i) * k, (a * i - c * g) * k, (c * d - a * f) * k,
    (d * h - e * g) * k, (b * g - a * h) * k, (a * e - b * d) * k,
  ]
}

const cubicTaps = t => {
  const A = -0.75
  const c0 = ((A * (t + 1) - 5 * A) * (t + 1) + 8 * A) * (t + 1) - 4 * A
  const c1 = ((A + 2) * t - (A + 3)) * t * t + 1
  const c2 = ((A + 2) * (1 - t) - (A + 3)) * (1 - t) * (1 - t) + 1
  return [c0, c1, c2, 1 - c0 - c1 - c2]
}
const CUBIC_TABLE = Array.from({ length: 32 }, (_, i) => cubicTaps(i / 32))

/** cv2.warpPerspective(rgba, M, (outW, outH), INTER_CUBIC, BORDER_REPLICATE): M maps the source to the output.
 *  Positions are rounded to 1/32 pixel as OpenCV does. */
export function warpPerspectiveCubic(rgba, width, height, matrix, outW, outH) {
  const inv = invert3(matrix)
  const out = new Uint8ClampedArray(outW * outH * 4)
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const w0 = inv[6] * x + inv[7] * y + inv[8]
      const w = w0 ? 32 / w0 : 0
      const X = Math.round((inv[0] * x + inv[1] * y + inv[2]) * w)
      const Y = Math.round((inv[3] * x + inv[4] * y + inv[5]) * w)
      const sx = X >> 5
      const sy = Y >> 5
      const wx = CUBIC_TABLE[X & 31]
      const wy = CUBIC_TABLE[Y & 31]
      let r = 0
      let g = 0
      let b = 0
      for (let j = 0; j < 4; j++) {
        const yy = Math.min(height - 1, Math.max(0, sy - 1 + j))
        for (let i = 0; i < 4; i++) {
          const xx = Math.min(width - 1, Math.max(0, sx - 1 + i))
          const p = (yy * width + xx) * 4
          const k = wy[j] * wx[i]
          r += rgba[p] * k
          g += rgba[p + 1] * k
          b += rgba[p + 2] * k
        }
      }
      const o = (y * outW + x) * 4
      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
      out[o + 3] = 255
    }
  }
  return out
}
