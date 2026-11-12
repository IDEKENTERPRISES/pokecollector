// The speed test itself: loads onnxruntime-web (only when called: nothing here is imported by the rest of the app),
// times every step and reports rows to the page. No image ever leaves this module: the photo is decoded on a canvas
// and only timings and device facts go out.
import { l2Normalise, parseIndex, searchTopK } from './index8'
import { fromHalfBits, preprocessRgba, toHalfBits, VIEWS_PER_CARD } from './preprocess'
import { median, round, timeRuns } from './stats'
import { cardViews, CARD_H, CARD_W, ctcDecode, detectionTensor, guideCardBox, recognitionTensor, textLines, cropRgba } from './views'

export const ORT_VERSION = '1.31.1'
export const RUNS = 5
const CRASH_KEY = 'pcPhoneSpeedStep'

// -- onnxruntime-web, loaded on demand -------------------------------------------------------------------------------

let wasmRuntime = null
let gpuRuntime = null

/** The WebAssembly-only build (single thread: the app is not cross-origin isolated). Its .wasm is a Vite asset of this origin. */
export async function loadWasmRuntime() {
  if (!wasmRuntime) {
    wasmRuntime = (async () => {
      const [ort, wasm] = await Promise.all([import('onnxruntime-web/wasm'), import('onnxruntime-web/ort-wasm-simd-threaded.wasm?url')])
      ort.env.wasm.numThreads = 1
      ort.env.wasm.proxy = false
      ort.env.wasm.wasmPaths = { wasm: new URL(wasm.default, window.location.href).href }
      return ort
    })()
  }
  return wasmRuntime
}

/** The build with the WebGPU execution provider. Its bundle has the "asyncify" glue inlined (checked in the built chunk), so the
 *  matching .wasm is the asyncify one (~29 MB), also served from this origin. */
export async function loadGpuRuntime() {
  if (!gpuRuntime) {
    gpuRuntime = (async () => {
      const [ort, wasm] = await Promise.all([import('onnxruntime-web/webgpu'), import('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url')])
      ort.env.wasm.numThreads = 1
      ort.env.wasm.proxy = false
      ort.env.wasm.wasmPaths = { wasm: new URL(wasm.default, window.location.href).href }
      return ort
    })()
  }
  return gpuRuntime
}

// -- device facts ----------------------------------------------------------------------------------------------------

export function readDevice(nav = globalThis.navigator, win = globalThis) {
  const ua = String(nav?.userAgent || '')
  const ios = /OS (\d+)[._](\d+)/.exec(ua)
  const safari = /Version\/(\d+(?:\.\d+)?)/.exec(ua)
  return {
    ua: ua.slice(0, 190),
    ios: ios ? `${ios[1]}.${ios[2]}` : null,
    safari: safari ? safari[1] : null,
    gpu: Boolean(nav?.gpu),
    crossOriginIsolated: Boolean(win?.crossOriginIsolated),
    hardwareConcurrency: Number(nav?.hardwareConcurrency) || null,
    ortVersion: ORT_VERSION,
  }
}

// -- the crash flag --------------------------------------------------------------------------------------------------

const store = () => { try { return globalThis.sessionStorage } catch { return null } }

/** The step that was running when the page last went away, if the run never finished. */
export function previousCrash() {
  try { return store()?.getItem(CRASH_KEY) || null } catch { return null }
}
export function markStep(name) {
  try { if (name) store()?.setItem(CRASH_KEY, name); else store()?.removeItem(CRASH_KEY) } catch { /* storage blocked */ }
}

// -- helpers ---------------------------------------------------------------------------------------------------------

const errorText = error => String(error?.message || error || 'failed').replace(/\s+/g, ' ').slice(0, 190)

/** Decode a photo (File, Blob or URL) onto a canvas and read the RGBA pixels (longest side limited to 1920, like a video frame). */
export async function decodePhoto(source, maxSide = 1920) {
  const blob = typeof source === 'string' ? await (await fetch(source)).blob() : source
  let bitmap
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } catch {
    bitmap = await createImageBitmap(blob)
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()
  const { data } = context.getImageData(0, 0, width, height)
  canvas.width = canvas.height = 0
  return { data, width, height }
}

/** The card the test embeds: the centre guide crop of the photo, resized to the matcher's flat card size. */
export function guideCard(photo) {
  const crop = cropRgba(photo.data, photo.width, photo.height, guideCardBox(photo.width, photo.height))
  const canvas = document.createElement('canvas')
  canvas.width = crop.width
  canvas.height = crop.height
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(crop.data), crop.width, crop.height), 0, 0)
  const out = document.createElement('canvas')
  out.width = CARD_W
  out.height = CARD_H
  const context = out.getContext('2d', { willReadFrequently: true })
  context.imageSmoothingQuality = 'high'
  context.drawImage(canvas, 0, 0, CARD_W, CARD_H)
  const { data } = context.getImageData(0, 0, CARD_W, CARD_H)
  canvas.width = canvas.height = out.width = out.height = 0
  return { data, width: CARD_W, height: CARD_H }
}

async function embedOne(ort, session, tensorData, half) {
  const input = half
    ? new ort.Tensor('float16', toHalfBits(tensorData), [1, 3, 224, 224])
    : new ort.Tensor('float32', tensorData, [1, 3, 224, 224])
  const out = await session.run({ [session.inputNames[0]]: input })
  const result = out[session.outputNames[0]]
  const data = await result.getData()
  const values = result.type === 'float16' ? fromHalfBits(data) : data
  const dim = result.dims[result.dims.length - 1]
  const cls = Float32Array.from(values.subarray(0, dim)) // the CLS token, like OnnxEmbedder.embed
  result.dispose?.()
  return l2Normalise(cls)
}

function wantsHalf(session) {
  const meta = session.inputMetadata
  const first = Array.isArray(meta) ? meta[0] : meta?.[session.inputNames[0]]
  return String(first?.type || '').includes('float16')
}

// -- the run ---------------------------------------------------------------------------------------------------------

export const STEP_IDS = [
  ['session_wasm', 'Model session, uint8 on WebAssembly'],
  ['session_webgpu_fp16', 'Model session, fp16 on WebGPU'],
  ['session_webgpu_uint8', 'Model session, uint8 on WebGPU'],
  ['photo', 'Photo decode and guide crop (once)'],
  ['preprocess', 'Preprocess to the 224×224 tensor'],
  ['embed_wasm', 'One embedding, WebAssembly'],
  ['card_wasm', `One card, ${VIEWS_PER_CARD.total} embeddings, WebAssembly`],
  ['embed_webgpu_fp16', 'One embedding, WebGPU fp16'],
  ['card_webgpu_fp16', `One card, ${VIEWS_PER_CARD.total} embeddings, WebGPU fp16`],
  ['embed_webgpu_uint8', 'One embedding, WebGPU uint8'],
  ['card_webgpu_uint8', `One card, ${VIEWS_PER_CARD.total} embeddings, WebGPU uint8`],
  ['index_load', 'Index files into memory (once)'],
  ['search_whole', 'Whole-card top-20 search, one query'],
  ['search_art', 'Artwork top-20 search, one query'],
  ['ocr_det_session', 'OCR detection session, WebAssembly'],
  ['ocr_rec_session', 'OCR recognition session, WebAssembly'],
  ['ocr_det_run', 'OCR detection, one card-sized image'],
  ['ocr_rec_run', 'OCR recognition, 3 text lines'],
]

// What the kept set (IN_USE + wholeread + wholestrict) is assumed to need per card, besides the embeddings and searches:
// two detection runs on a card-sized picture (the card, and the whole-picture second read) and six line recognitions
// (the name line, the number strips and a retry). It is a rough guess, stated on the page: step 3 replaces it with a measurement.
export const OCR_ASSUMPTION = { detections: 2, recognitions: 6 }

/** The estimated per-card total of the kept set in ms, from the step medians. */
export function estimateCard(medians, backend) {
  const embed = medians[`card_${backend}`]
  const pre = medians.preprocess
  const whole = medians.search_whole
  const art = medians.search_art
  const det = medians.ocr_det_run
  const rec = medians.ocr_rec_run
  if ([embed, pre, whole, art, det, rec].some(value => value === null || value === undefined)) return null
  return pre * VIEWS_PER_CARD.total + embed + whole * (VIEWS_PER_CARD.orientation + VIEWS_PER_CARD.tta) + art * VIEWS_PER_CARD.art
    + det * OCR_ASSUMPTION.detections + (rec / 3) * OCR_ASSUMPTION.recognitions
}

/**
 * Run every step. `files` = {manifest, read(path) -> ArrayBuffer}. `onRow(id, row)` gets {first, median, runs, note} or {error}.
 * `options.webgpu` false skips the WebGPU steps. Returns {timings, device} for the server.
 */
export async function runSpeedTest({ files, photoSource, onRow, onPhase, options = {} }) {
  const device = readDevice()
  const rows = {}
  const set = (id, row) => { rows[id] = row; onRow(id, row) }
  const guard = async (id, fn) => {
    markStep(id)
    onPhase?.(id)
    try {
      await fn()
    } catch (error) {
      set(id, { error: errorText(error) })
      device.errors = `${device.errors ? `${device.errors} | ` : ''}${id}: ${errorText(error)}`.slice(0, 190)
    }
  }
  const timed = async (id, step, runs = RUNS, note = null) => {
    const result = await timeRuns(step, runs)
    set(id, { first: result.first, median: result.median, runs: result.runs, note })
    return result
  }
  const manifest = files.manifest
  const int8Path = manifest.model.file
  const fp16Path = manifest.model.webgpu_candidate?.in_bundle ? manifest.model.webgpu_candidate.file : null
  const hasGpu = Boolean(globalThis.navigator?.gpu) && options.webgpu !== false

  // the photo
  let photo = null
  let card = null
  let views = null
  let tensor = null
  await guard('photo', async () => {
    const result = await timeRuns(async () => {
      photo = await decodePhoto(photoSource)
      card = guideCard(photo)
    }, 1)
    set('photo', { first: result.first, median: result.first, runs: result.runs, note: `${photo.width}×${photo.height} photo → ${card.width}×${card.height} card` })
    device.photoWidth = photo.width
    device.photoHeight = photo.height
  })
  if (!card) return finish(rows, device)
  views = cardViews(card)

  await guard('preprocess', async () => {
    const result = await timed('preprocess', () => { tensor = preprocessRgba(card.data, card.width, card.height) }, RUNS, `${card.width}×${card.height} RGBA → 3×224×224 float32`)
    return result
  })
  if (!tensor) tensor = preprocessRgba(card.data, card.width, card.height)

  const medians = () => Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, row.median ?? null]))
  const embeddings = {}

  /** Session creation (5 times, each released but the last) then one embedding and one 7-view card on that backend. */
  const modelSteps = async (backend, ort, path, providers, sessionId, embedId, cardId) => {
    const buffer = await files.read(path)
    if (!buffer) throw new Error('The file is not in the cache')
    let session = null
    await guard(sessionId, async () => {
      const result = await timeRuns(async () => {
        session?.release?.()
        session = await ort.InferenceSession.create(new Uint8Array(buffer), { executionProviders: providers, graphOptimizationLevel: 'all' })
      }, RUNS)
      set(sessionId, { first: result.first, median: result.median, runs: result.runs })
    })
    if (!session) return
    const half = wantsHalf(session)
    try {
      await guard(embedId, async () => {
        const result = await timed(embedId, async () => { embeddings[backend] = await embedOne(ort, session, tensor, half) })
        return result
      })
      await guard(cardId, async () => {
        await timed(cardId, async () => {
          for (const view of views) await embedOne(ort, session, preprocessRgba(view.data, view.width, view.height), half)
        }, RUNS, 'preprocess included: one tensor per view')
      })
    } finally {
      session.release?.()
    }
  }

  // WebAssembly, uint8
  await guard('session_wasm', async () => {
    const ort = await loadWasmRuntime()
    await modelSteps('wasm', ort, int8Path, ['wasm'], 'session_wasm', 'embed_wasm', 'card_wasm')
  })

  // WebGPU, fp16 and uint8 (integer operators may fall back to the CPU or fail: either is a result)
  if (hasGpu) {
    await guard('session_webgpu_fp16', async () => {
      if (!fp16Path) { set('session_webgpu_fp16', { error: 'the fp16 model is not in the bundle' }); return }
      const ort = await loadGpuRuntime()
      await modelSteps('webgpu_fp16', ort, fp16Path, ['webgpu'], 'session_webgpu_fp16', 'embed_webgpu_fp16', 'card_webgpu_fp16')
    })
    await guard('session_webgpu_uint8', async () => {
      const ort = await loadGpuRuntime()
      await modelSteps('webgpu_uint8', ort, int8Path, ['webgpu'], 'session_webgpu_uint8', 'embed_webgpu_uint8', 'card_webgpu_uint8')
    })
  } else {
    for (const id of ['session_webgpu_fp16', 'session_webgpu_uint8']) set(id, { error: options.webgpu === false ? 'skipped' : 'navigator.gpu does not exist here' })
  }

  // the index
  const query = embeddings.wasm || embeddings.webgpu_fp16 || embeddings.webgpu_uint8
  const wholeIndexes = []
  const artIndexes = []
  await guard('index_load', async () => {
    const result = await timeRuns(async () => {
      for (const entry of manifest.files.filter(item => item.path.startsWith('index/'))) {
        const buffer = await files.read(entry.path)
        if (!buffer) throw new Error(`${entry.path} is not in the cache`)
        ;(entry.path.startsWith('index/whole/') ? wholeIndexes : artIndexes).push(parseIndex(buffer))
      }
    }, 1)
    const rowsLoaded = wholeIndexes.reduce((sum, index) => sum + index.count, 0)
    set('index_load', { first: result.first, median: result.first, runs: result.runs, note: `${wholeIndexes.length + artIndexes.length} files, ${rowsLoaded.toLocaleString()} cards per kind` })
    device.indexCards = rowsLoaded
  })
  if (query && wholeIndexes.length) {
    await guard('search_whole', () => timed('search_whole', () => searchTopK(wholeIndexes, query, 20)))
    await guard('search_art', () => timed('search_art', () => searchTopK(artIndexes, query, 20)))
  } else {
    set('search_whole', { error: 'needs one embedding and the index' })
    set('search_art', { error: 'needs one embedding and the index' })
  }

  // OCR on WebAssembly
  await guard('ocr_det_session', async () => {
    const ort = await loadWasmRuntime()
    const detBuffer = await files.read('ocr/det.onnx')
    const recBuffer = await files.read('ocr/rec.onnx')
    const characters = new TextDecoder().decode(await files.read('ocr/characters.txt')).split('\n').filter(Boolean)
    let detection = null
    let recognition = null
    const create = async (id, buffer, assign) => {
      await guard(id, async () => {
        let held = null
        const result = await timeRuns(async () => {
          held?.release?.()
          held = await ort.InferenceSession.create(new Uint8Array(buffer), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
        }, RUNS)
        assign(held)
        set(id, { first: result.first, median: result.median, runs: result.runs })
      })
    }
    await create('ocr_det_session', detBuffer, session => { detection = session })
    await create('ocr_rec_session', recBuffer, session => { recognition = session })
    try {
      if (detection) {
        await guard('ocr_det_run', async () => {
          const input = detectionTensor(card)
          await timed('ocr_det_run', async () => {
            const out = await detection.run({ [detection.inputNames[0]]: new ort.Tensor('float32', input.data, input.dims) })
            const map = out[detection.outputNames[0]]
            await map.getData()
          }, RUNS, `${input.dims[3]}×${input.dims[2]} input (longest side 480)`)
        })
      }
      if (recognition) {
        await guard('ocr_rec_run', async () => {
          const lines = textLines(card).slice(0, 3).map(line => recognitionTensor(line))
          let text = []
          await timed('ocr_rec_run', async () => {
            text = []
            for (const line of lines) {
              const out = await recognition.run({ [recognition.inputNames[0]]: new ort.Tensor('float32', line.data, line.dims) })
              const result = out[recognition.outputNames[0]]
              const values = await result.getData()
              text.push(ctcDecode(values, result.dims[1], result.dims[2], characters))
            }
          }, RUNS, `read: ${text.map(item => item.trim()).filter(Boolean).join(' | ') || '(nothing)'}`)
          rows.ocr_rec_run.note = `3 lines of 48 px height; read: ${text.map(item => item.trim()).filter(Boolean).join(' | ') || '(nothing)'}`
          onRow('ocr_rec_run', rows.ocr_rec_run)
        })
      }
    } finally {
      detection?.release?.()
      recognition?.release?.()
    }
  })

  // the estimate
  const values = medians()
  const estimates = { wasm: estimateCard(values, 'wasm'), webgpu_fp16: estimateCard(values, 'webgpu_fp16'), webgpu_uint8: estimateCard(values, 'webgpu_uint8') }
  return finish(rows, device, estimates)
}

function finish(rows, device, estimates = {}) {
  markStep(null)
  const timings = {}
  for (const [id, row] of Object.entries(rows)) {
    timings[`${id}_first_ms`] = row.error ? null : round(row.first)
    timings[`${id}_median_ms`] = row.error ? null : round(row.median)
  }
  for (const [backend, value] of Object.entries(estimates)) timings[`estimate_card_${backend}_ms`] = round(value)
  device.estimateOcr = `${OCR_ASSUMPTION.detections} det + ${OCR_ASSUMPTION.recognitions} rec`
  return { timings, device, estimates, rows }
}

export { median }
