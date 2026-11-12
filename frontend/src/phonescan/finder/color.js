// Colour pieces of detect.py: the 8-bit CIE Lab conversion cv2 does (float formula, rounded; OpenCV's own uses a fixed-point
// table, so a value may differ by one level) and CLAHE exactly as OpenCV's cv::CLAHE computes it on an 8-bit plane.

const WHITE_X = 0.950456
const WHITE_Z = 1.088754
const GAMMA_TABLE = Float64Array.from({ length: 256 }, (_, v) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
})
const labF = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)

/** One RGB pixel to 8-bit Lab (L 0..255, a and b offset by 128), as cv2.cvtColor(COLOR_RGB2LAB) on uint8. */
export function rgbToLab8(r, g, b) {
  const R = GAMMA_TABLE[r]
  const G = GAMMA_TABLE[g]
  const B = GAMMA_TABLE[b]
  const X = (0.412453 * R + 0.35758 * G + 0.180423 * B) / WHITE_X
  const Y = 0.212671 * R + 0.71516 * G + 0.072169 * B
  const Z = (0.019334 * R + 0.119193 * G + 0.950227 * B) / WHITE_Z
  const fy = labF(Y)
  const L = Y > 0.008856 ? 116 * fy - 16 : 903.3 * Y
  return [
    Math.round(L * 255 / 100),
    Math.max(0, Math.min(255, Math.round(500 * (labF(X) - fy) + 128))),
    Math.max(0, Math.min(255, Math.round(200 * (fy - labF(Z)) + 128))),
  ]
}

const labFInverse = t => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787)
const gammaInverse = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

/** One 8-bit Lab pixel back to RGB bytes, as cv2.cvtColor(COLOR_LAB2RGB) on uint8. */
export function lab8ToRgb(L8, a8, b8) {
  const L = L8 * 100 / 255
  const bright = L > 8 // 903.3 * 0.008856
  const Y = bright ? ((L + 16) / 116) ** 3 : L / 903.3
  const fy = bright ? (L + 16) / 116 : 7.787 * Y + 16 / 116
  const X = labFInverse(fy + (a8 - 128) / 500) * WHITE_X
  const Z = labFInverse(fy - (b8 - 128) / 200) * WHITE_Z
  const R = 3.240479 * X - 1.53715 * Y - 0.498535 * Z
  const G = -0.969256 * X + 1.875991 * Y + 0.041556 * Z
  const B = 0.055648 * X - 0.204043 * Y + 1.057311 * Z
  const byte = c => Math.max(0, Math.min(255, Math.round(255 * gammaInverse(Math.max(0, Math.min(1, c))))))
  return [byte(R), byte(G), byte(B)]
}

/** cvRound: halves go to the even neighbour. */
function roundEven(value) {
  const floor = Math.floor(value)
  const diff = value - floor
  return diff < 0.5 ? floor : diff > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1
}

/** cv2.createCLAHE(clipLimit, (tiles, tiles)).apply(plane) for an 8-bit plane (OpenCV 4.10's algorithm). */
export function clahe8(plane, width, height, clipLimit = 2.0, tiles = 4) {
  // A picture whose sides are not both multiples of the grid is padded by mirroring (BORDER_REFLECT_101) on the right and the
  // bottom, and OpenCV pads by a whole grid step on a side that already divides evenly (880 high -> 884).
  const divisible = width % tiles === 0 && height % tiles === 0
  const extW = divisible ? width : width + tiles - (width % tiles)
  const extH = divisible ? height : height + tiles - (height % tiles)
  const refl = (i, n) => (i < n ? i : 2 * n - 2 - i)
  const ext = (x, y) => plane[refl(y, height) * width + refl(x, width)]
  const tileW = extW / tiles
  const tileH = extH / tiles
  const tileTotal = tileW * tileH
  const lutScale = Math.fround(255 / tileTotal)
  const limit = Math.max(Math.trunc(clipLimit * tileTotal / 256), 1)
  const luts = new Uint8Array(tiles * tiles * 256)
  const hist = new Int32Array(256)
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      hist.fill(0)
      for (let y = 0; y < tileH; y++) for (let x = 0; x < tileW; x++) hist[ext(tx * tileW + x, ty * tileH + y)]++
      let clipped = 0
      for (let i = 0; i < 256; i++) {
        if (hist[i] > limit) {
          clipped += hist[i] - limit
          hist[i] = limit
        }
      }
      const batch = Math.trunc(clipped / 256)
      let residual = clipped - batch * 256
      for (let i = 0; i < 256; i++) hist[i] += batch
      if (residual !== 0) {
        const stepBy = Math.max(Math.trunc(256 / residual), 1)
        for (let i = 0; i < 256 && residual > 0; i += stepBy, residual--) hist[i]++
      }
      let sum = 0
      const base = (ty * tiles + tx) * 256
      for (let i = 0; i < 256; i++) {
        sum += hist[i]
        luts[base + i] = Math.min(255, roundEven(Math.fround(sum * lutScale)))
      }
    }
  }
  const out = new Uint8Array(width * height)
  const invW = Math.fround(1 / tileW)
  const invH = Math.fround(1 / tileH)
  const x1 = new Int32Array(width)
  const x2 = new Int32Array(width)
  const xa = new Float32Array(width)
  for (let x = 0; x < width; x++) {
    const txf = Math.fround(Math.fround(x * invW) - 0.5)
    const t1 = Math.floor(txf)
    xa[x] = Math.fround(txf - t1)
    x1[x] = Math.max(t1, 0)
    x2[x] = Math.min(t1 + 1, tiles - 1)
  }
  for (let y = 0; y < height; y++) {
    const tyf = Math.fround(Math.fround(y * invH) - 0.5)
    const t1 = Math.floor(tyf)
    const ya = Math.fround(tyf - t1)
    const row1 = Math.max(t1, 0) * tiles
    const row2 = Math.min(t1 + 1, tiles - 1) * tiles
    for (let x = 0; x < width; x++) {
      const v = plane[y * width + x]
      const a = xa[x]
      const a1 = Math.fround(1 - a)
      const p11 = luts[(row1 + x1[x]) * 256 + v]
      const p12 = luts[(row1 + x2[x]) * 256 + v]
      const p21 = luts[(row2 + x1[x]) * 256 + v]
      const p22 = luts[(row2 + x2[x]) * 256 + v]
      const f = Math.fround
      const res = f(f(f(f(p11 * a1) + f(p12 * a)) * f(1 - ya)) + f(f(f(p21 * a1) + f(p22 * a)) * ya))
      out[y * width + x] = Math.max(0, Math.min(255, roundEven(res)))
    }
  }
  return out
}
