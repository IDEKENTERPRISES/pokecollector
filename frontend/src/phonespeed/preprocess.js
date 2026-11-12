// The matcher's model input, ported from backend/services/card_match/embed.py `preprocess` (matcher version 11).
// Pure functions over RGBA pixel data (what canvas getImageData returns): no DOM, no canvas, so the phone matcher
// of step 3 can reuse them in a worker and the unit tests can run them in Node.
//
//   embed.preprocess(image, size, mean, std):
//     cv2.resize(image, (size, size), INTER_AREA if min(h, w) > size else INTER_CUBIC)
//     -> float32 / 255 -> (x - mean) / std per RGB channel -> transpose to CHW.
//
// cv2's two resizers are re-implemented, not approximated:
//   INTER_AREA  : every destination pixel is the exact area-weighted average of the source pixels under it
//                 (fractional overlap at the edges, cv2's resizeArea with its 1e-3 edge threshold);
//   INTER_CUBIC : Keys cubic with a = -0.75, centre-aligned sampling ((x + 0.5) * scale - 0.5), replicated border.
// cv2 computes the uint8 cubic in 11-bit fixed point and rounds the result; this port uses floats and rounds to the
// nearest integer, so single pixels can differ by one level (1/255 before normalisation). The tests state the tolerance.

export const INPUT_SIZE = 224
export const MEAN = [0.485, 0.456, 0.406]
export const STD = [0.229, 0.224, 0.225]

const clampByte = value => (value < 0 ? 0 : value > 255 ? 255 : Math.round(value))

/** cv2 resizeArea's per-axis table: for each destination index, the source indexes and weights (sum 1). */
function areaTable(srcSize, dstSize) {
  const scale = srcSize / dstSize
  const table = []
  for (let d = 0; d < dstSize; d++) {
    const start = d * scale
    const end = start + scale
    let first = Math.ceil(start)
    let last = Math.floor(end)
    last = Math.min(last, srcSize - 1)
    first = Math.min(first, last)
    const cell = Math.min(scale, srcSize - start)
    const index = []
    const weight = []
    if (first - start > 1e-3) {
      index.push(first - 1)
      weight.push((first - start) / cell)
    }
    for (let s = first; s < last; s++) {
      index.push(s)
      weight.push(1 / cell)
    }
    if (end - last > 1e-3) {
      index.push(last)
      weight.push(Math.min(Math.min(end - last, 1), cell) / cell)
    }
    table.push({ index, weight })
  }
  return table
}

/** RGBA (or RGB when `channels` is 3) -> RGB Uint8ClampedArray of dw x dh, area-averaged (shrinking). */
export function resizeArea(src, sw, sh, dw, dh, channels = 4) {
  const xs = areaTable(sw, dw)
  const ys = areaTable(sh, dh)
  const out = new Uint8ClampedArray(dw * dh * 3)
  const row = new Float64Array(dw * 3)
  for (let y = 0; y < dh; y++) {
    row.fill(0)
    const { index: yi, weight: yw } = ys[y]
    for (let k = 0; k < yi.length; k++) {
      const base = yi[k] * sw * channels
      const wy = yw[k]
      for (let x = 0; x < dw; x++) {
        const { index: xi, weight: xw } = xs[x]
        let r = 0
        let g = 0
        let b = 0
        for (let j = 0; j < xi.length; j++) {
          const p = base + xi[j] * channels
          const w = xw[j]
          r += src[p] * w
          g += src[p + 1] * w
          b += src[p + 2] * w
        }
        row[x * 3] += r * wy
        row[x * 3 + 1] += g * wy
        row[x * 3 + 2] += b * wy
      }
    }
    for (let i = 0; i < dw * 3; i++) out[y * dw * 3 + i] = clampByte(row[i])
  }
  return out
}

function cubicWeights(t) {
  const a = -0.75
  const c0 = ((a * (t + 1) - 5 * a) * (t + 1) + 8 * a) * (t + 1) - 4 * a
  const c1 = ((a + 2) * t - (a + 3)) * t * t + 1
  const c2 = ((a + 2) * (1 - t) - (a + 3)) * (1 - t) * (1 - t) + 1
  return [c0, c1, c2, 1 - c0 - c1 - c2]
}

/** RGBA (or RGB) -> RGB Uint8ClampedArray of dw x dh, bicubic (enlarging). */
export function resizeCubic(src, sw, sh, dw, dh, channels = 4) {
  const out = new Uint8ClampedArray(dw * dh * 3)
  const scaleX = sw / dw
  const scaleY = sh / dh
  const columns = []
  for (let x = 0; x < dw; x++) {
    const fx = (x + 0.5) * scaleX - 0.5
    const sx = Math.floor(fx)
    columns.push({ sx, w: cubicWeights(fx - sx) })
  }
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) * scaleY - 0.5
    const sy = Math.floor(fy)
    const wy = cubicWeights(fy - sy)
    for (let x = 0; x < dw; x++) {
      const { sx, w: wx } = columns[x]
      let r = 0
      let g = 0
      let b = 0
      for (let j = 0; j < 4; j++) {
        const yy = Math.min(Math.max(sy - 1 + j, 0), sh - 1)
        for (let i = 0; i < 4; i++) {
          const xx = Math.min(Math.max(sx - 1 + i, 0), sw - 1)
          const p = (yy * sw + xx) * channels
          const w = wy[j] * wx[i]
          r += src[p] * w
          g += src[p + 1] * w
          b += src[p + 2] * w
        }
      }
      const o = (y * dw + x) * 3
      out[o] = clampByte(r)
      out[o + 1] = clampByte(g)
      out[o + 2] = clampByte(b)
    }
  }
  return out
}

/**
 * RGBA pixels of any size -> the model's input tensor: Float32Array(3 * size * size), CHW, RGB order,
 * normalised with the ImageNet mean and std (embed.preprocess).
 */
export function preprocessRgba(rgba, width, height, size = INPUT_SIZE, mean = MEAN, std = STD) {
  const rgb = Math.min(width, height) > size
    ? resizeArea(rgba, width, height, size, size)
    : resizeCubic(rgba, width, height, size, size)
  const plane = size * size
  const out = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) out[c * plane + i] = (rgb[i * 3 + c] / 255 - mean[c]) / std[c]
  }
  return out
}

/** Mean and (population) standard deviation of a tensor, as the fixture's `tensor.mean` / `tensor.std`. */
export function tensorStats(tensor) {
  let sum = 0
  for (let i = 0; i < tensor.length; i++) sum += tensor[i]
  const mean = sum / tensor.length
  let square = 0
  for (let i = 0; i < tensor.length; i++) square += (tensor[i] - mean) ** 2
  return { mean, std: Math.sqrt(square / tensor.length) }
}

/** float32 -> IEEE half bits (round to nearest even), for a float16 model input. Returns Uint16Array. */
export function toHalfBits(values) {
  const f32 = new Float32Array(1)
  const u32 = new Uint32Array(f32.buffer)
  const out = new Uint16Array(values.length)
  for (let i = 0; i < values.length; i++) {
    f32[0] = values[i]
    const x = u32[0]
    const sign = (x >>> 16) & 0x8000
    let exponent = ((x >>> 23) & 0xff) - 127 + 15
    let mantissa = x & 0x7fffff
    if (((x >>> 23) & 0xff) === 0xff) {
      out[i] = sign | 0x7c00 | (mantissa ? 0x200 : 0)
    } else if (exponent >= 31) {
      out[i] = sign | 0x7c00
    } else if (exponent <= 0) {
      if (exponent < -10) {
        out[i] = sign
      } else {
        mantissa |= 0x800000
        const shift = 14 - exponent
        let half = mantissa >> shift
        const rest = mantissa & ((1 << shift) - 1)
        const mid = 1 << (shift - 1)
        if (rest > mid || (rest === mid && (half & 1))) half++
        out[i] = sign | half
      }
    } else {
      let half = (exponent << 10) | (mantissa >> 13)
      const rest = mantissa & 0x1fff
      if (rest > 0x1000 || (rest === 0x1000 && (half & 1))) half++
      out[i] = sign | half
    }
  }
  return out
}

/** IEEE half bits (Uint16Array) -> Float32Array, for a float16 model output. */
export function fromHalfBits(bits) {
  const out = new Float32Array(bits.length)
  for (let i = 0; i < bits.length; i++) {
    const h = bits[i]
    const sign = h & 0x8000 ? -1 : 1
    const exponent = (h >> 10) & 0x1f
    const mantissa = h & 0x3ff
    if (exponent === 0) out[i] = sign * mantissa * 2 ** -24
    else if (exponent === 31) out[i] = mantissa ? NaN : sign * Infinity
    else out[i] = sign * (1 + mantissa / 1024) * 2 ** (exponent - 15)
  }
  return out
}

// The views the kept option set embeds per card (pipeline.py `_picture_scores`, `detect.py`):
//   2 orientations (card as found and turned 180 degrees, one batch),
//   + 2 test-time-augmentation views (a tighter crop, a brightness-normalised copy) of the oriented card for the whole-card search,
//   + 3 artwork-window crops (the oriented card and its two extra views) for the artwork search.
export const VIEWS_PER_CARD = { orientation: 2, tta: 2, art: 3, total: 7 }
