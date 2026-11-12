// Helpers for the text reader's tests only (they read the fixtures of backend/scripts/phone_parity_ocr.py): a small PNG
// decoder, base64 + deflate unpacking and model sessions that replay recorded detector and recogniser outputs.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

export const OCR_FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'phone-matcher', 'v11', 'ocr')
export const readFixture = name => JSON.parse(readFileSync(resolve(OCR_FIXTURES, name), 'utf-8'))

/** base64 of deflated bytes -> Buffer */
export const unpack = text => inflateSync(Buffer.from(text, 'base64'))

/** 8-bit RGB or RGBA PNG (no interlacing) -> {data: RGBA Uint8ClampedArray, width, height} */
export function decodePng(bytes) {
  let pos = 8
  let width = 0
  let height = 0
  let channels = 3
  const chunks = []
  while (pos < bytes.length) {
    const length = bytes.readUInt32BE(pos)
    const type = bytes.toString('latin1', pos + 4, pos + 8)
    const body = bytes.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      if (body[8] !== 8 || body[12] !== 0) throw new Error('only 8-bit non-interlaced PNGs')
      channels = { 2: 3, 6: 4 }[body[9]]
      if (!channels) throw new Error(`colour type ${body[9]} is not supported`)
    } else if (type === 'IDAT') chunks.push(body)
    pos += 12 + length
  }
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x]
      const left = x >= channels ? pixels[y * stride + x - channels] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0
      let predictor = 0
      if (filter === 1) predictor = left
      else if (filter === 2) predictor = up
      else if (filter === 3) predictor = (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      pixels[y * stride + x] = (value + predictor) & 255
    }
  }
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = pixels[i * channels]
    data[i * 4 + 1] = pixels[i * channels + 1]
    data[i * 4 + 2] = pixels[i * channels + 2]
    data[i * 4 + 3] = channels === 4 ? pixels[i * 4 + 3] : 255
  }
  return { data, width, height }
}

export const loadCard = file => decodePng(readFileSync(resolve(OCR_FIXTURES, file)))

/** RGB bytes (as the fixtures keep small pictures) -> an RGBA picture */
export function rgbToImage(bytes, width, height) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = bytes[i * 3]
    data[i * 4 + 1] = bytes[i * 3 + 1]
    data[i * 4 + 2] = bytes[i * 3 + 2]
    data[i * 4 + 3] = 255
  }
  return { data, width, height }
}

/** A detection map event -> {data: Float32Array probabilities, width, height} (the 8-bit values the Python reader ran on). */
export function eventMap(event) {
  const bytes = unpack(event.map)
  const [height, width] = event.map_dims
  const data = new Float32Array(width * height)
  for (let i = 0; i < data.length; i++) data[i] = Math.fround(bytes[i] / 255)
  return { data, width, height }
}

/** The compact recogniser output of a recorded event: best class and probability of every step of every crop. */
export function eventLogits(event) {
  const idx = unpack(event.indices)
  const val = unpack(event.values)
  const count = idx.length / 2
  const indices = new Uint16Array(count)
  const values = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    indices[i] = idx.readUInt16LE(i * 2)
    values[i] = val.readUInt16LE(i * 2) / 10000
  }
  return { steps: event.steps, indices, values }
}

/**
 * Sessions that replay a recorded call list in order. Every call is checked against the recording: the detector's input must
 * have the recorded shape and (within ``meanTolerance``) the recorded mean, the recogniser's the recorded shape (its width within a few columns). ``mismatches``
 * collects what did not fit instead of throwing, so one run reports everything.
 */
export function replaySessions(events, characters, { meanTolerance = 0.02, recWidthTolerance = 6 } = {}) {
  let next = 0
  const mismatches = []
  const take = kind => {
    const event = events[next++]
    if (!event || event.kind !== kind) {
      mismatches.push(`call ${next - 1}: expected ${event ? event.kind : 'nothing'}, got ${kind}`)
      throw new Error(mismatches[mismatches.length - 1])
    }
    return event
  }
  const mean = data => { let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i]; return sum / data.length }
  return {
    characters,
    mismatches,
    get used() { return next },
    detect(tensor) {
      const event = take('det')
      if (JSON.stringify(tensor.dims) !== JSON.stringify(event.dims)) mismatches.push(`det ${next - 1}: input ${tensor.dims} vs recorded ${event.dims}`)
      else if (Math.abs(mean(tensor.data) - event.input_mean) > meanTolerance) mismatches.push(`det ${next - 1}: input mean ${mean(tensor.data).toFixed(4)} vs recorded ${event.input_mean}`)
      return eventMap(event)
    },
    recognise(tensor) {
      const event = take('rec')
      // A box a pixel wider or narrower than Python's (the ports of minAreaRect and pyclipper differ by float rounding) changes the
      // padded width of a batch by a few columns: batch size and height must be equal, the width within `recWidthTolerance`.
      const [n, c, h, w] = tensor.dims
      const [en, ec, eh, ew] = event.dims
      if (n !== en || c !== ec || h !== eh || Math.abs(w - ew) > Math.max(recWidthTolerance, 0.03 * ew)) mismatches.push(`rec ${next - 1}: input ${tensor.dims} vs recorded ${event.dims}`)
      else if (w === ew && Math.abs(mean(tensor.data) - event.input_mean) > meanTolerance * 2) mismatches.push(`rec ${next - 1}: input mean ${mean(tensor.data).toFixed(4)} vs recorded ${event.input_mean}`)
      return eventLogits(event)
    },
  }
}
