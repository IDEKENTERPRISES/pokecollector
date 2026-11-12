// The speed test itself: loads onnxruntime-web (only when called: nothing here is imported by the rest of the app),
// times every step and reports rows to the page. No image ever leaves this module: the photo is decoded on a canvas
// and only timings and device facts go out.
import { l2Normalise, parseIndex, searchTopK, topkAnswer } from './index8'
import { fromHalfBits, preprocessRgba, toHalfBits, VIEWS_PER_CARD } from './preprocess'
import { median, round, timeRuns } from './stats'
import {
  clearPartial, markStep, newPartial, ORT_VERSION, parseDevice, phaseOrder, previousCrash, recordStep, timingsOf,
} from './plan'
import { cardViews, CARD_H, CARD_W, ctcDecode, detectionTensor, guideCardBox, recognitionTensor, textLines, cropRgba } from './views'

export { ORT_VERSION, markStep, previousCrash }
export const RUNS = 5

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

export const readDevice = parseDevice

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
  ['photo', 'Photo decode and guide crop (once)'],
  ['preprocess', 'Preprocess to the 224×224 tensor'],
  ['embed_wasm', 'One embedding, WebAssembly'],
  ['embed_art_wasm', 'One artwork-window embedding, WebAssembly'],
  ['card_wasm', `One card, ${VIEWS_PER_CARD.total} embeddings, WebAssembly`],
  ['embed_webgpu_fp16', 'One embedding, WebGPU fp16'],
  ['embed_art_webgpu_fp16', 'One artwork-window embedding, WebGPU fp16'],
  ['card_webgpu_fp16', `One card, ${VIEWS_PER_CARD.total} embeddings, WebGPU fp16`],
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
 * Run every step in `phaseOrder` (WebAssembly first, WebGPU last). `files` = {manifest, read(path) -> ArrayBuffer}.
 * `onRow(id, row)` gets {first, median, runs, note} or {error}. Every finished step is saved at once (`recordStep`), so a crash
 * or an early end keeps what is done: the page posts the partial run. `options.webgpu` false skips WebGPU. The 8-bit model on
 * WebGPU is never run (it crashes Safari on iOS 26.6). Returns {timings, device, ...} for the server.
 */
export async function runSpeedTest({ files, photoSource, onRow, onPhase, options = {}, storage }) {
  const device = readDevice()
  const rows = {}
  const partial = newPartial(device)
  const runId = partial.runId
  const set = (id, row) => {
    rows[id] = row
    recordStep(partial, id, row, storage)
    onRow(id, row)
  }
  const guard = async (id, fn) => {
    markStep(id, storage)
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

  let photo = null
  let card = null
  let views = null
  const getViews = () => { views = views || cardViews(card); return views }
  const dropViews = () => { views = null }
  let tensor = null
  const medians = () => Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, row.median ?? null]))
  const embeddings = {}
  const artEmbeddings = {} // the artwork index is searched with the embedding of the card's artwork window, not of the whole card
  const answer = { topk: {}, ocr_lines: [] }
  const wholeIndexes = []
  const artIndexes = []

  /** Session creation (5 times, each released), then one embedding and one 7-view card on that backend. The session is released
   *  at the end, and a WebGPU phase starts only after everything before it released its sessions: two models are never held at once. */
  const modelSteps = async (backend, ort, path, providers, sessionId, embedId, cardId) => {
    let buffer = await files.read(path)
    if (!buffer) throw new Error('The file is not in the cache')
    let session = null
    await guard(sessionId, async () => {
      const result = await timeRuns(async () => {
        if (session) { await session.release?.(); session = null }
        session = await ort.InferenceSession.create(new Uint8Array(buffer), { executionProviders: providers, graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false })
      }, RUNS)
      set(sessionId, { first: result.first, median: result.median, runs: result.runs })
    })
    buffer = null // the model bytes are in the session now
    if (!session) return
    const half = wantsHalf(session)
    try {
      await guard(embedId, async () => {
        await timed(embedId, async () => { embeddings[backend] = await embedOne(ort, session, tensor, half) })
      })
      await guard(`embed_art_${backend}`, async () => {
        const art = getViews().find(view => view.name === 'art')
        const artTensor = preprocessRgba(art.data, art.width, art.height)
        await timed(`embed_art_${backend}`, async () => { artEmbeddings[backend] = await embedOne(ort, session, artTensor, half) })
      })
      await guard(cardId, async () => {
        await timed(cardId, async () => {
          for (const view of getViews()) await embedOne(ort, session, preprocessRgba(view.data, view.width, view.height), half)
        }, RUNS, 'preprocess included: one tensor per view')
      })
    } finally {
      await session.release?.()
      session = null
      dropViews() // seven RGBA pictures are not kept while the next phase runs
    }
  }

  const addTopk = backend => {
    const embedding = embeddings[backend]
    if (!embedding || !wholeIndexes.length) return
    answer.topk[backend] = topkAnswer({ embedding, artEmbedding: artEmbeddings[backend], wholeIndexes, artIndexes })
  }

  /** The two search rows need one embedding and the index; with no WebAssembly embedding they wait for the first WebGPU one. */
  const searchRows = async backend => {
    const query = embeddings[backend]
    if (!query || !wholeIndexes.length || rows.search_whole) return
    await guard('search_whole', () => timed('search_whole', () => searchTopK(wholeIndexes, query, 20)))
    await guard('search_art', () => timed('search_art', () => searchTopK(artIndexes, artEmbeddings[backend] || query, 20)))
  }

  const phases = {
    async photo() {
      await guard('photo', async () => {
        const result = await timeRuns(async () => {
          photo = await decodePhoto(photoSource)
          card = guideCard(photo)
        }, 1)
        set('photo', { first: result.first, median: result.first, runs: result.runs, note: `${photo.width}×${photo.height} photo → ${card.width}×${card.height} card` })
        device.photoWidth = photo.width
        device.photoHeight = photo.height
      })
      photo = null // the decoded photo (11 MB of pixels) is not needed once the card is cut from it
    },
    async preprocess() {
      await guard('preprocess', async () => {
        await timed('preprocess', () => { tensor = preprocessRgba(card.data, card.width, card.height) }, RUNS, `${card.width}×${card.height} RGBA → 3×224×224 float32`)
      })
      if (!tensor) tensor = preprocessRgba(card.data, card.width, card.height)
    },
    async wasm() {
      await guard('session_wasm', async () => {
        const ort = await loadWasmRuntime()
        await modelSteps('wasm', ort, int8Path, ['wasm'], 'session_wasm', 'embed_wasm', 'card_wasm')
      })
    },
    async index() {
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
      await searchRows('wasm')
      addTopk('wasm')
    },
    async ocr() {
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
              await held?.release?.()
              held = await ort.InferenceSession.create(new Uint8Array(buffer), { executionProviders: ['wasm'], graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false })
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
              }, RUNS)
              answer.ocr_lines = text.map(item => item.trim().slice(0, 190)).filter(Boolean).slice(0, 20)
              rows.ocr_rec_run.note = `3 lines of 48 px height; read: ${text.map(item => item.trim()).filter(Boolean).join(' | ') || '(nothing)'}`
              onRow('ocr_rec_run', rows.ocr_rec_run)
            })
          }
        } finally {
          await detection?.release?.()
          await recognition?.release?.()
        }
      })
    },
    async webgpu_fp16() {
      await guard('session_webgpu_fp16', async () => {
        if (!fp16Path) { set('session_webgpu_fp16', { error: 'the fp16 model is not in the bundle' }); return }
        const ort = await loadGpuRuntime()
        await modelSteps('webgpu_fp16', ort, fp16Path, ['webgpu'], 'session_webgpu_fp16', 'embed_webgpu_fp16', 'card_webgpu_fp16')
      })
      await searchRows('webgpu_fp16')
      addTopk('webgpu_fp16')
    },
  }

  for (const phase of phaseOrder({ webgpu: hasGpu })) {
    await phases[phase]()
    if (phase === 'photo' && !card) return finish(rows, device, {}, answer, storage, runId) // nothing else can run without the photo
  }
  if (!hasGpu) {
    for (const id of ['session_webgpu_fp16']) set(id, { error: options.webgpu === false ? 'skipped' : 'navigator.gpu does not exist here' })
  }

  const values = medians()
  const estimates = { wasm: estimateCard(values, 'wasm'), webgpu_fp16: estimateCard(values, 'webgpu_fp16') }
  return finish(rows, device, estimates, answer, storage, runId)
}

function finish(rows, device, estimates = {}, answer = { topk: {}, ocr_lines: [] }, storage, runId = null) {
  markStep(null, storage)
  clearPartial(storage)
  const timings = timingsOf(rows)
  for (const [backend, value] of Object.entries(estimates)) timings[`estimate_card_${backend}_ms`] = round(value)
  device.estimateOcr = `${OCR_ASSUMPTION.detections} det + ${OCR_ASSUMPTION.recognitions} rec`
  return { timings, device, estimates, rows, answer, runId }
}

export { median }
