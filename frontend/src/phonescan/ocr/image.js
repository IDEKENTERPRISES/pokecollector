// Picture operations for the text reader, as pure functions over RGBA pixels ({data, width, height}, 4 bytes a pixel).
// They stand in for the OpenCV calls ocr.py makes (INTER_CUBIC resize, GaussianBlur + addWeighted, LAB CLAHE, rotate)
// and RapidOCR makes (INTER_LINEAR resize, perspective warp). No OpenCV: the formulas are OpenCV's, in floating point, so a
// pixel can differ from the 8-bit fixed-point original by one or two levels (stated in docs/phone-scanner/ocr.md).

const clampByte = value => (value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value))

/** Python's round() and OpenCV's cvRound: halves go to the even neighbour. */
export function roundHalfEven(value) {
  const floor = Math.floor(value)
  const diff = value - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

export function makeImage(width, height) {
  return { data: new Uint8ClampedArray(width * height * 4), width, height }
}

/** The sub-picture at a box given as fractions of the picture, cut the way ocr.py does (int(), no rounding up). */
export function cropFraction(img, [x0, y0, x1, y1]) {
  const left = Math.trunc(x0 * img.width)
  const top = Math.trunc(y0 * img.height)
  const right = Math.min(img.width, Math.trunc(x1 * img.width))
  const bottom = Math.min(img.height, Math.trunc(y1 * img.height))
  const width = Math.max(0, right - left)
  const height = Math.max(0, bottom - top)
  const out = makeImage(width, height)
  for (let y = 0; y < height; y++) {
    const from = ((top + y) * img.width + left) * 4
    out.data.set(img.data.subarray(from, from + width * 4), y * width * 4)
  }
  return out
}

export function rotate180(img) {
  const out = makeImage(img.width, img.height)
  const count = img.width * img.height
  for (let i = 0; i < count; i++) {
    const j = count - 1 - i
    out.data[i * 4] = img.data[j * 4]
    out.data[i * 4 + 1] = img.data[j * 4 + 1]
    out.data[i * 4 + 2] = img.data[j * 4 + 2]
    out.data[i * 4 + 3] = img.data[j * 4 + 3]
  }
  return out
}

/** np.rot90: a quarter turn counter-clockwise (the result is height x width). */
export function rotate90(img) {
  const out = makeImage(img.height, img.width)
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const from = (x * img.width + (img.width - 1 - y)) * 4
      out.data.set(img.data.subarray(from, from + 4), (y * out.width + x) * 4)
    }
  }
  return out
}

/** Pad rows of black above and below (cv2.copyMakeBorder, constant 0). */
export function padRows(img, rows) {
  const out = makeImage(img.width, img.height + 2 * rows)
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255
  out.data.set(img.data, rows * img.width * 4)
  return out
}

// ── resizing ─────────────────────────────────────────────────────────────────

function cubicWeights(t) {
  const a = -0.75
  const c0 = ((a * (t + 1) - 5 * a) * (t + 1) + 8 * a) * (t + 1) - 4 * a
  const c1 = ((a + 2) * t - (a + 3)) * t * t + 1
  const c2 = ((a + 2) * (1 - t) - (a + 3)) * (1 - t) * (1 - t) + 1
  return [c0, c1, c2, 1 - c0 - c1 - c2]
}

/** cv2.resize(img, None, fx=zoom, fy=zoom, INTER_CUBIC): the output is round(size * zoom), source positions use 1 / zoom. */
export function resizeCubicZoom(img, zoom) {
  const width = Math.max(1, roundHalfEven(img.width * zoom))
  const height = Math.max(1, roundHalfEven(img.height * zoom))
  const scale = 1 / zoom
  const xs = new Int32Array(width * 4)
  const xw = new Float32Array(width * 4)
  for (let x = 0; x < width; x++) {
    const fx = (x + 0.5) * scale - 0.5
    const sx = Math.floor(fx)
    const w = cubicWeights(fx - sx)
    for (let k = 0; k < 4; k++) {
      xs[x * 4 + k] = Math.min(Math.max(sx - 1 + k, 0), img.width - 1)
      xw[x * 4 + k] = w[k]
    }
  }
  // horizontal pass into floats, then the vertical pass
  const mid = new Float32Array(width * img.height * 3)
  for (let y = 0; y < img.height; y++) {
    const row = y * img.width * 4
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let k = 0; k < 4; k++) {
        const p = row + xs[x * 4 + k] * 4
        const w = xw[x * 4 + k]
        r += img.data[p] * w
        g += img.data[p + 1] * w
        b += img.data[p + 2] * w
      }
      const o = (y * width + x) * 3
      mid[o] = r
      mid[o + 1] = g
      mid[o + 2] = b
    }
  }
  const out = makeImage(width, height)
  for (let y = 0; y < height; y++) {
    const fy = (y + 0.5) * scale - 0.5
    const sy = Math.floor(fy)
    const w = cubicWeights(fy - sy)
    const rows = [0, 1, 2, 3].map(k => Math.min(Math.max(sy - 1 + k, 0), img.height - 1) * width * 3)
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        const value = mid[rows[0] + x * 3 + c] * w[0] + mid[rows[1] + x * 3 + c] * w[1] + mid[rows[2] + x * 3 + c] * w[2] + mid[rows[3] + x * 3 + c] * w[3]
        out.data[(y * width + x) * 4 + c] = clampByte(value)
      }
      out.data[(y * width + x) * 4 + 3] = 255
    }
  }
  return out
}

/** cv2.resize(img, (width, height)) with the default INTER_LINEAR (two by two neighbours, no averaging when shrinking). */
export function resizeLinear(img, width, height) {
  const out = makeImage(width, height)
  const scaleX = img.width / width
  const scaleY = img.height / height
  const x0 = new Int32Array(width)
  const x1 = new Int32Array(width)
  const fxs = new Float32Array(width)
  for (let x = 0; x < width; x++) {
    let fx = (x + 0.5) * scaleX - 0.5
    let sx = Math.floor(fx)
    fx -= sx
    if (sx < 0) { fx = 0; sx = 0 }
    if (sx >= img.width - 1) { fx = 0; sx = img.width - 1 }
    x0[x] = sx
    x1[x] = Math.min(sx + 1, img.width - 1)
    fxs[x] = fx
  }
  for (let y = 0; y < height; y++) {
    let fy = (y + 0.5) * scaleY - 0.5
    let sy = Math.floor(fy)
    fy -= sy
    if (sy < 0) { fy = 0; sy = 0 }
    if (sy >= img.height - 1) { fy = 0; sy = img.height - 1 }
    const sy1 = Math.min(sy + 1, img.height - 1)
    for (let x = 0; x < width; x++) {
      const a = (sy * img.width + x0[x]) * 4
      const b = (sy * img.width + x1[x]) * 4
      const c = (sy1 * img.width + x0[x]) * 4
      const d = (sy1 * img.width + x1[x]) * 4
      const fx = fxs[x]
      const o = (y * width + x) * 4
      for (let ch = 0; ch < 3; ch++) {
        const top = img.data[a + ch] * (1 - fx) + img.data[b + ch] * fx
        const bottom = img.data[c + ch] * (1 - fx) + img.data[d + ch] * fx
        out.data[o + ch] = clampByte(top * (1 - fy) + bottom * fy)
      }
      out.data[o + 3] = 255
    }
  }
  return out
}

// ── perspective crop (RapidOCR get_rotate_crop_image) ────────────────────────

/** Solve the 3x3 homography (h33 = 1) taking four points ``from`` to four points ``to``. */
function homography(from, to) {
  const rows = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i]
    const [u, v] = to[i]
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  for (let col = 0; col < 8; col++) { // Gaussian elimination with partial pivoting
    let pivot = col
    for (let r = col + 1; r < 8; r++) if (Math.abs(rows[r][col]) > Math.abs(rows[pivot][col])) pivot = r
    ;[rows[col], rows[pivot]] = [rows[pivot], rows[col]]
    const lead = rows[col][col]
    if (Math.abs(lead) < 1e-12) return null
    for (let c = col; c < 9; c++) rows[col][c] /= lead
    for (let r = 0; r < 8; r++) {
      if (r === col) continue
      const factor = rows[r][col]
      if (factor !== 0) for (let c = col; c < 9; c++) rows[r][c] -= factor * rows[col][c]
    }
  }
  return rows.map(row => row[8])
}

/**
 * The text line inside a four-point box (top-left, top-right, bottom-right, bottom-left) straightened to a rectangle, like
 * RapidOCR: size from the longer of the opposite sides, bicubic sampling with replicated borders, positions in 1/32 pixel
 * steps as warpPerspective does, and a quarter turn when the line is taller than 1.5 times its width.
 */
export function warpBox(img, points) {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
  const width = Math.trunc(Math.max(dist(points[0], points[1]), dist(points[2], points[3])))
  const height = Math.trunc(Math.max(dist(points[0], points[3]), dist(points[1], points[2])))
  if (width < 1 || height < 1) return null
  const h = homography([[0, 0], [width, 0], [width, height], [0, height]], points) // destination -> source
  if (!h) return null
  const out = makeImage(width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const w = h[6] * x + h[7] * y + 1
      const sx = (h[0] * x + h[1] * y + h[2]) / w
      const sy = (h[3] * x + h[4] * y + h[5]) / w
      const fxq = Math.round(sx * 32)
      const fyq = Math.round(sy * 32)
      const ix = fxq >> 5
      const iy = fyq >> 5
      const wx = cubicWeights((fxq & 31) / 32)
      const wy = cubicWeights((fyq & 31) / 32)
      let r = 0
      let g = 0
      let b = 0
      for (let j = 0; j < 4; j++) {
        const yy = Math.min(Math.max(iy - 1 + j, 0), img.height - 1)
        for (let i = 0; i < 4; i++) {
          const xx = Math.min(Math.max(ix - 1 + i, 0), img.width - 1)
          const p = (yy * img.width + xx) * 4
          const weight = wy[j] * wx[i]
          r += img.data[p] * weight
          g += img.data[p + 1] * weight
          b += img.data[p + 2] * weight
        }
      }
      const o = (y * width + x) * 4
      out.data[o] = clampByte(r)
      out.data[o + 1] = clampByte(g)
      out.data[o + 2] = clampByte(b)
      out.data[o + 3] = 255
    }
  }
  return height / width >= 1.5 ? rotate90(out) : out
}

// ── the preprocessing variants (ocr.prepare) ─────────────────────────────────

/** A normalised Gaussian kernel the way cv2.GaussianBlur(sigma, ksize 0) builds it for 8-bit pictures: size |6 sigma + 1| made odd. */
function gaussianKernel(sigma) {
  const size = roundHalfEven(sigma * 6 + 1) | 1
  const half = size >> 1
  const kernel = new Float64Array(size)
  let sum = 0
  for (let i = 0; i < size; i++) {
    kernel[i] = Math.exp(-((i - half) ** 2) / (2 * sigma * sigma))
    sum += kernel[i]
  }
  for (let i = 0; i < size; i++) kernel[i] /= sum
  return kernel
}

const reflect101 = (index, size) => {
  if (size === 1) return 0
  while (index < 0 || index >= size) index = index < 0 ? -index : 2 * (size - 1) - index
  return index
}

function gaussianBlur(img, sigma) {
  const kernel = gaussianKernel(sigma)
  const half = kernel.length >> 1
  const { width, height } = img
  const mid = new Float32Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let k = 0; k < kernel.length; k++) {
        const p = (y * width + reflect101(x + k - half, width)) * 4
        r += img.data[p] * kernel[k]
        g += img.data[p + 1] * kernel[k]
        b += img.data[p + 2] * kernel[k]
      }
      const o = (y * width + x) * 3
      mid[o] = r
      mid[o + 1] = g
      mid[o + 2] = b
    }
  }
  const out = new Float32Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let k = 0; k < kernel.length; k++) {
      const row = reflect101(y + k - half, height) * width * 3
      const w = kernel[k]
      for (let i = 0; i < width * 3; i++) out[y * width * 3 + i] += mid[row + i] * w
    }
  }
  return out
}

/** cv2.addWeighted(strip, 1.8, GaussianBlur(strip, sigma 2), -0.8, 0): an unsharp mask. */
function sharp(img) {
  const blurred = gaussianBlur(img, 2.0)
  const out = makeImage(img.width, img.height)
  for (let i = 0, j = 0; i < img.data.length; i += 4, j += 3) {
    out.data[i] = clampByte(img.data[i] * 1.8 - blurred[j] * 0.8)
    out.data[i + 1] = clampByte(img.data[i + 1] * 1.8 - blurred[j + 1] * 0.8)
    out.data[i + 2] = clampByte(img.data[i + 2] * 1.8 - blurred[j + 2] * 0.8)
    out.data[i + 3] = 255
  }
  return out
}

// sRGB <-> CIE LAB, D65, 8-bit layout of OpenCV (L 0..255, a and b offset by 128)
const SRGB_TO_LINEAR = new Float64Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
const XN = 0.950456
const ZN = 1.088754
const labF = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
const labFInverse = t => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787)
const gamma = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

function toLab(img) {
  const count = img.width * img.height
  const L = new Uint8Array(count)
  const A = new Uint8Array(count)
  const B = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    const r = SRGB_TO_LINEAR[img.data[i * 4]]
    const g = SRGB_TO_LINEAR[img.data[i * 4 + 1]]
    const b = SRGB_TO_LINEAR[img.data[i * 4 + 2]]
    const x = (0.412453 * r + 0.35758 * g + 0.180423 * b) / XN
    const y = 0.212671 * r + 0.71516 * g + 0.072169 * b
    const z = (0.019334 * r + 0.119193 * g + 0.950227 * b) / ZN
    const fy = labF(y)
    const l = y > 0.008856 ? 116 * fy - 16 : 903.3 * y
    L[i] = clampByte(l * 255 / 100)
    A[i] = clampByte(500 * (labF(x) - fy) + 128)
    B[i] = clampByte(200 * (fy - labF(z)) + 128)
  }
  return { L, A, B }
}

function fromLab({ L, A, B }, width, height) {
  const out = makeImage(width, height)
  for (let i = 0; i < width * height; i++) {
    const l = L[i] * 100 / 255
    const fy = (l + 16) / 116
    const y = l > 7.9996 ? fy * fy * fy : l / 903.3
    const fx = fy + (A[i] - 128) / 500
    const fz = fy - (B[i] - 128) / 200
    const x = labFInverse(fx) * XN
    const z = labFInverse(fz) * ZN
    const r = 3.240479 * x - 1.53715 * y - 0.498535 * z
    const g = -0.969256 * x + 1.875991 * y + 0.041556 * z
    const b = 0.055648 * x - 0.204043 * y + 1.057311 * z
    const o = i * 4
    out.data[o] = clampByte(255 * gamma(Math.min(Math.max(r, 0), 1)))
    out.data[o + 1] = clampByte(255 * gamma(Math.min(Math.max(g, 0), 1)))
    out.data[o + 2] = clampByte(255 * gamma(Math.min(Math.max(b, 0), 1)))
    out.data[o + 3] = 255
  }
  return out
}

/** cv2.createCLAHE(clip, tileGridSize=(tilesX, tilesY)).apply(plane): contrast-limited adaptive histogram equalisation. */
export function clahe(plane, width, height, clip, tilesX, tilesY) {
  // OpenCV pads with reflected borders when EITHER side is not a multiple of the grid, and then adds a whole grid step to a
  // side that already was one (tilesY - rows % tilesY is tilesY for a multiple)
  const divisible = width % tilesX === 0 && height % tilesY === 0
  const padW = divisible ? width : width + tilesX - (width % tilesX)
  const padH = divisible ? height : height + tilesY - (height % tilesY)
  const src = new Uint8Array(padW * padH)
  for (let y = 0; y < padH; y++) {
    const sy = reflect101(y, height)
    for (let x = 0; x < padW; x++) src[y * padW + x] = plane[sy * width + reflect101(x, width)]
  }
  const tileW = padW / tilesX
  const tileH = padH / tilesY
  const total = tileW * tileH
  const clipLimit = Math.max(Math.trunc(clip * total / 256), 1)
  const luts = new Uint8Array(tilesX * tilesY * 256)
  const lutScale = Math.fround(255 / total)
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const hist = new Int32Array(256)
      for (let y = 0; y < tileH; y++) for (let x = 0; x < tileW; x++) hist[src[(ty * tileH + y) * padW + tx * tileW + x]]++
      let clipped = 0
      for (let i = 0; i < 256; i++) {
        if (hist[i] > clipLimit) { clipped += hist[i] - clipLimit; hist[i] = clipLimit }
      }
      const batch = Math.trunc(clipped / 256)
      let residual = clipped - batch * 256
      for (let i = 0; i < 256; i++) hist[i] += batch
      if (residual !== 0) {
        const step = Math.max(Math.trunc(256 / residual), 1)
        for (let i = 0; i < 256 && residual > 0; i += step, residual--) hist[i]++
      }
      let sum = 0
      const base = (ty * tilesX + tx) * 256
      for (let i = 0; i < 256; i++) {
        sum += hist[i]
        luts[base + i] = clampByte(Math.fround(sum * lutScale))
      }
    }
  }
  const out = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    const tyf = y / tileH - 0.5
    let ty1 = Math.floor(tyf)
    let ty2 = ty1 + 1
    const ya = tyf - ty1
    ty1 = Math.max(ty1, 0)
    ty2 = Math.min(ty2, tilesY - 1)
    for (let x = 0; x < width; x++) {
      const txf = x / tileW - 0.5
      let tx1 = Math.floor(txf)
      let tx2 = tx1 + 1
      const xa = txf - tx1
      tx1 = Math.max(tx1, 0)
      tx2 = Math.min(tx2, tilesX - 1)
      const value = plane[y * width + x]
      const res = (luts[(ty1 * tilesX + tx1) * 256 + value] * (1 - xa) + luts[(ty1 * tilesX + tx2) * 256 + value] * xa) * (1 - ya) +
        (luts[(ty2 * tilesX + tx1) * 256 + value] * (1 - xa) + luts[(ty2 * tilesX + tx2) * 256 + value] * xa) * ya
      out[y * width + x] = clampByte(res)
    }
  }
  return out
}

function claheStrip(img, clip = 3.0) {
  const lab = toLab(img)
  lab.L = clahe(lab.L, img.width, img.height, clip, 8, 3)
  return fromLab(lab, img.width, img.height)
}

/**
 * The strip as the recogniser should see it (ocr.prepare): ``plain`` as photographed, ``sharp`` unsharp mask, ``clahe`` local
 * contrast normalisation. The slow variants ``binary`` and ``deglare`` are not ported (the phone uses the fast ladder).
 */
export function prepare(img, variant) {
  if (variant === 'plain') return img
  if (variant === 'sharp') return sharp(img)
  if (variant === 'clahe') return claheStrip(img)
  throw new Error(`variant ${variant} is not ported (the fast ladder only uses plain, sharp and clahe)`)
}

export { claheStrip }
