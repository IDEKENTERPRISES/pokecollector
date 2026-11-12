// RapidOCR's text recognition around the PP-OCRv4 recogniser: the batches (six crops, sorted by aspect ratio, padded to the
// widest of the batch), the input tensors (BGR, height 48, (x / 255 - 0.5) / 0.5) and the CTC greedy decode with the model's
// character list and a mean confidence. The recogniser itself is run by the caller. Mirrors rapidocr_onnxruntime 1.3.24
// ch_ppocr_v3_rec (rec_img_shape [3, 48, 320], rec_batch_num 6, use_cls false).
import { resizeLinear, makeImage } from './image'

export const REC_HEIGHT = 48
export const REC_BATCH = 6

/** characters.txt (the model's character list, one per line) -> the decoder's table: blank first, the space class last. */
export function characterTable(text) {
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return ['blank', ...lines.map(line => line.replace(/\r$/, '')), ' ']
}

/** The crops in the recogniser's batches: indices sorted by width / height (ties keep their order), six at a time. */
export function batchesOf(crops) {
  const order = crops.map((_, i) => i).sort((a, b) => crops[a].width / crops[a].height - crops[b].width / crops[b].height || a - b)
  const batches = []
  for (let i = 0; i < order.length; i += REC_BATCH) batches.push(order.slice(i, i + REC_BATCH))
  return batches
}

/** One batch of crops -> the recogniser's input {data, dims: [n, 3, 48, W]}, W = int(48 * the widest aspect ratio). */
export function recognitionBatch(crops, indices) {
  let maxRatio = 0
  for (const i of indices) maxRatio = Math.max(maxRatio, crops[i].width / crops[i].height)
  const width = Math.trunc(REC_HEIGHT * maxRatio)
  const plane = REC_HEIGHT * width
  const data = new Float32Array(indices.length * 3 * plane) // zero padding on the right, as RapidOCR pads after normalising
  indices.forEach((cropIndex, n) => {
    const crop = crops[cropIndex]
    const ratio = crop.width / crop.height
    const resizedWidth = Math.ceil(REC_HEIGHT * ratio) > width ? width : Math.ceil(REC_HEIGHT * ratio)
    const resized = resizeLinear(crop, resizedWidth, REC_HEIGHT)
    const base = n * 3 * plane
    for (let y = 0; y < REC_HEIGHT; y++) {
      for (let x = 0; x < resizedWidth; x++) {
        const p = (y * resizedWidth + x) * 4
        const o = y * width + x
        data[base + o] = (resized.data[p + 2] / 255 - 0.5) / 0.5 // blue first (BGR)
        data[base + plane + o] = (resized.data[p + 1] / 255 - 0.5) / 0.5
        data[base + 2 * plane + o] = (resized.data[p] / 255 - 0.5) / 0.5
      }
    }
  })
  return { data, dims: [indices.length, 3, REC_HEIGHT, width] }
}

/**
 * CTC greedy decode of one recognised line. ``logits`` is the model's output for the batch, {data, dims [n, steps, classes]}
 * (probabilities, already softmaxed), or the compact form {steps, indices, values} holding only each step's best class and its
 * probability (what the parity fixtures record). Returns [{text, score}] with the score the mean probability of the kept steps.
 */
export function ctcDecodeBatch(logits, characters) {
  const out = []
  if (logits.indices) {
    const { steps } = logits
    const count = logits.indices.length / steps
    for (let n = 0; n < count; n++) out.push(decodeSteps(steps, t => logits.indices[n * steps + t], t => logits.values[n * steps + t], characters))
    return out
  }
  const [count, steps, classes] = logits.dims
  for (let n = 0; n < count; n++) {
    const best = new Int32Array(steps)
    const prob = new Float32Array(steps)
    for (let t = 0; t < steps; t++) {
      const base = (n * steps + t) * classes
      let arg = 0
      for (let c = 1; c < classes; c++) if (logits.data[base + c] > logits.data[base + arg]) arg = c
      best[t] = arg
      prob[t] = logits.data[base + arg]
    }
    out.push(decodeSteps(steps, t => best[t], t => prob[t], characters))
  }
  return out
}

function decodeSteps(steps, indexAt, probAt, characters) {
  let text = ''
  let total = 0
  let kept = 0
  let any = false
  let previous = -1
  for (let t = 0; t < steps; t++) {
    const index = indexAt(t)
    const repeat = t > 0 && previous === index
    previous = index
    if (index === 0 || repeat) continue
    text += characters[index] ?? ' '
    const p = probAt(t)
    total += p
    kept++
    if (p) any = true
  }
  return { text, score: kept && any ? total / kept : 0 }
}

/** Fill a blank white picture (a helper for tests). */
export function blankImage(width, height, value = 255) {
  const img = makeImage(width, height)
  img.data.fill(value)
  return img
}
