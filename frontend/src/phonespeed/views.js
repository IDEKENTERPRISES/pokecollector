// The pictures one card is embedded from, built from RGBA pixel data (pure functions: no canvas), and the text-line
// crops the OCR step feeds the recogniser. Boxes come from the server's detect.py / names.py / ocr.py (matcher version 11).
import { resizeArea, resizeCubic } from './preprocess'

export const CARD_W = 630
export const CARD_H = 880
export const ART_BOX = [0.07, 0.115, 0.93, 0.545] // detect.ART_BOX: x0, y0, x1, y1 as fractions of the card
export const NAME_STRIP = [0.03, 0.02, 1.0, 0.15] // names.NAME_STRIP
export const NUMBER_STRIPS = [[0.0, 0.945, 0.55, 1.0], [0.45, 0.945, 1.0, 1.0]] // ocr.STRIPS["tight"]
export const OCR_DET_SIDE = 480 // the reader's det_limit_side_len

/** A rectangle of an RGBA picture as its own RGBA picture. */
export function cropRgba(rgba, width, height, [x0, y0, x1, y1]) {
  const left = Math.max(0, Math.floor(x0 * width))
  const top = Math.max(0, Math.floor(y0 * height))
  const right = Math.min(width, Math.floor(x1 * width))
  const bottom = Math.min(height, Math.floor(y1 * height))
  const w = right - left
  const h = bottom - top
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const from = ((top + y) * width + left) * 4
    out.set(rgba.subarray(from, from + w * 4), y * w * 4)
  }
  return { data: out, width: w, height: h }
}

/** The picture turned 180 degrees (a card held upside down). */
export function rotate180(rgba, width, height) {
  const out = new Uint8ClampedArray(rgba.length)
  const pixels = width * height
  for (let i = 0; i < pixels; i++) {
    const to = (pixels - 1 - i) * 4
    out[to] = rgba[i * 4]
    out[to + 1] = rgba[i * 4 + 1]
    out[to + 2] = rgba[i * 4 + 2]
    out[to + 3] = 255
  }
  return { data: out, width, height }
}

/** detect.augmented_views, first view: a 3.5% tighter centre crop (stretched back to the card size on the server;
 *  the 224 px resize that follows makes the stretch immaterial for timing). */
export function tightView(rgba, width, height) {
  const mx = Math.floor(0.035 * width)
  const my = Math.floor(0.035 * height)
  return cropRgba(rgba, width, height, [mx / width, my / height, (width - mx) / width, (height - my) / height])
}

/** detect.augmented_views, second view: the server equalises the lightness with CLAHE. The speed test uses a global
 *  contrast stretch as a same-cost stand-in (the pictures are not compared, only timed). */
export function contrastView(rgba, width, height) {
  let low = 255
  let high = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const lum = (rgba[i] * 3 + rgba[i + 1] * 6 + rgba[i + 2]) / 10
    if (lum < low) low = lum
    if (lum > high) high = lum
  }
  const gain = high > low ? 255 / (high - low) : 1
  const out = new Uint8ClampedArray(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = (rgba[i] - low) * gain
    out[i + 1] = (rgba[i + 1] - low) * gain
    out[i + 2] = (rgba[i + 2] - low) * gain
    out[i + 3] = 255
  }
  return { data: out, width, height }
}

/** The seven pictures the kept option set embeds for one card (pipeline._picture_scores):
 *  upright and turned, the two test-time-augmentation views, and the artwork crop of upright and both extra views. */
export function cardViews(card) {
  const { data, width, height } = card
  const upright = { data, width, height }
  const turned = rotate180(data, width, height)
  const tight = tightView(data, width, height)
  const bright = contrastView(data, width, height)
  const art = picture => cropRgba(picture.data, picture.width, picture.height, ART_BOX)
  return [
    { name: 'upright', ...upright }, { name: 'turned', ...turned },
    { name: 'tight', ...tight }, { name: 'contrast', ...bright },
    { name: 'art', ...art(upright) }, { name: 'art-tight', ...art(tight) }, { name: 'art-contrast', ...art(bright) },
  ]
}

/** The centre guide crop of a photo as a 63:88 card: what the server uses when the finder is not run. */
export function guideCardBox(width, height) {
  let cardH = 0.9 * height
  let cardW = cardH * 63 / 88
  if (cardW > 0.96 * width) {
    cardW = 0.96 * width
    cardH = cardW * 88 / 63
  }
  return [(width - cardW) / 2 / width, (height - cardH) / 2 / height, (width + cardW) / 2 / width, (height + cardH) / 2 / height]
}

/** The reader's detection input size: the longest side limited to 480 and both sides rounded to a multiple of 32. */
export function detectionSize(width, height, limit = OCR_DET_SIDE) {
  const ratio = Math.max(width, height) > limit ? limit / Math.max(width, height) : 1
  const round = value => Math.max(32, Math.round(value * ratio / 32) * 32)
  return { width: round(width), height: round(height) }
}

/** An RGBA picture -> the PP-OCR detector's input: NCHW float32, (x/255 - mean) / std, resized (area) to the detection size. */
export function detectionTensor(card) {
  const { width, height } = detectionSize(card.width, card.height)
  const rgb = card.width > width ? resizeArea(card.data, card.width, card.height, width, height) : resizeCubic(card.data, card.width, card.height, width, height)
  const mean = [0.485, 0.456, 0.406]
  const std = [0.229, 0.224, 0.225]
  const plane = width * height
  const out = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) out[c * plane + i] = (rgb[i * 3 + c] / 255 - mean[c]) / std[c]
  return { data: out, dims: [1, 3, height, width] }
}

/** A text-line crop -> the PP-OCR recogniser's input: height 48, width by aspect (at most 320, padded), (x/255 - 0.5) / 0.5. */
export function recognitionTensor(line, maxWidth = 320) {
  const height = 48
  const width = Math.min(maxWidth, Math.max(32, Math.round(height * line.width / line.height)))
  const rgb = line.height > height ? resizeArea(line.data, line.width, line.height, width, height) : resizeCubic(line.data, line.width, line.height, width, height)
  const plane = height * width
  const out = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) out[c * plane + i] = (rgb[i * 3 + c] / 255 - 0.5) / 0.5
  return { data: out, dims: [1, 3, height, width] }
}

/** The three text-line crops of a card the recognition step reads: the name line and the two number strips. */
export function textLines(card) {
  return [NAME_STRIP, ...NUMBER_STRIPS].map(box => cropRgba(card.data, card.width, card.height, box))
}

/** CTC greedy decode of a recogniser output [1, steps, classes]: index 0 is blank, the last class is a space. */
export function ctcDecode(data, steps, classes, characters) {
  let text = ''
  let previous = -1
  for (let t = 0; t < steps; t++) {
    let best = 0
    for (let c = 1; c < classes; c++) if (data[t * classes + c] > data[t * classes + best]) best = c
    if (best !== 0 && best !== previous) text += best - 1 < characters.length ? characters[best - 1] : ' '
    previous = best
  }
  return text
}
