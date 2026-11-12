// The matcher's side of the worker: a message handler with everything environment-specific passed in, so the unit tests run the
// protocol in Node with fakes and the real `worker.js` is a few lines around it.
//
// Messages (client -> host):  init {manifest, mode, mainGpu, budgets}  match {photo, options}  release {}  rpc-result {callId, result|error}
// Messages (host -> client):  ready {info}  progress {stage}  result {result}  error {code, message}  rpc {callId, method, payload}
// Every client message that expects an answer carries an `id`, and the answer carries it back. `rpc` is the host asking the client
// to do something on the main thread (load the fp16 model there, embed tensors there) when this scope has no WebGPU.
//
// What lives here, loaded once: the ORT sessions (one embedding model, the reader's two), the picture indexes and the catalogue
// indexes (built lazily, once per catalogue signature, from the offline card database). Two embedding models are never held at once.
import { createLazyIndexes } from '../decide/catalogue'
import { thresholdsFromManifest } from '../decide/thresholds'
import { checkManifest } from './guard'
import { ortEmbedder, remoteEmbedder } from './embedder'
import { createPhoneMatcher } from './matcher'
import { createOcrSessions } from './ocrSessions'
import { recordSessions } from './ocrStats'
import { characterTable } from '../ocr'
import { diagnoseWebGpu } from './gpuDiag'
import { pictureIndexFromBuffers } from './pictureIndex'

export const MODES = ['auto', 'worker-webgpu', 'main-webgpu', 'main-wasm', 'wasm']
export const OCR_BACKENDS = ['wasm', 'webgpu-main']
/** The reader's ladder: 'server' is the server's (parity-checked); 'lean' stops after the first three steps (see docs/phone-scanner/integration.md for its cost). */
export const OCR_PROFILES = { server: {}, lean: { maxSteps: 3 } }

/**
 * createMatcherHost({post, files, loadWasm, loadGpu, probeGpu, cardDb, create...}) -> {handle(message), state}
 *   post(message, transfer?)   sends a message to the client
 *   files.read(path)           -> Promise<ArrayBuffer | null> (the downloaded bundle's files)
 *   loadWasm() / loadGpu()     -> the ORT module (WebAssembly build / WebGPU build)
 *   probeGpu()                 -> {available, reason} for THIS scope
 *   cardDb                     the offline card database's store ({getMeta, scanSets}) or null
 *   now                        clock in ms
 */
export function createMatcherHost({ post, files, loadWasm, loadGpu, probeGpu, cardDb = null, now = () => performance.now(), build = {} }) {
  const make = {
    ortEmbedder, remoteEmbedder, createOcrSessions, createPhoneMatcher, pictureIndexFromBuffers, createLazyIndexes, ...build,
  }
  const state = { ready: false, manifest: null, embedder: null, sessions: null, index: null, matcher: null, info: null, getIndexes: null, queue: Promise.resolve() }
  const waiting = new Map()
  let nextCall = 1

  const rpc = (method, payload, transfer = []) => new Promise((resolve, reject) => {
    const callId = nextCall++
    waiting.set(callId, { resolve, reject })
    post({ type: 'rpc', callId, method, payload }, transfer)
  })

  async function readAll(manifest, prefix) {
    const out = {}
    for (const entry of manifest.files.filter(item => item.path.startsWith(prefix))) {
      const buffer = await files.read(entry.path)
      if (!buffer) throw new Error(`${entry.path} is not downloaded on this phone`)
      out[entry.path] = buffer
    }
    return out
  }

  /** The embedding model, by the order the mode allows. Records what was tried. */
  async function chooseEmbedder(manifest, mode, mainGpu, tried) {
    const int8Path = manifest.model.file
    const fp16 = manifest.model.webgpu_candidate?.in_bundle ? manifest.model.webgpu_candidate.file : null
    const here = await probeGpu()
    tried.push({ step: 'probe worker WebGPU', ok: here.available, note: here.reason })
    const gpuHere = here.available && Boolean(fp16)
    const gpuMain = Boolean(mainGpu) && Boolean(fp16)
    const order = []
    // Automatic does NOT try the worker: on Safari 26 the worker's WebGPU session fails, and a failed attempt leaves a second WebGPU runtime (the 29 MB asyncify
    // wasm, a device, the model bytes) alive next to the main thread's, which is a candidate for the page being killed. Ask for it with 'worker-webgpu'.
    if (mode === 'worker-webgpu' && gpuHere) order.push('worker-webgpu')
    if ((mode === 'auto' || mode === 'main-webgpu') && gpuMain) order.push('main-webgpu')
    if (mode === 'main-wasm') order.push('main-wasm') // the 8-bit model on WebAssembly on the main thread: the reader can run in the worker beside it
    order.push('wasm') // never uint8 on WebGPU: the fallback is always WebAssembly
    for (const way of [...new Set(order)]) {
      try {
        if (way === 'worker-webgpu') {
          const ort = await loadGpu()
          const buffer = await files.read(fp16)
          if (!buffer) throw new Error('the fp16 model is not downloaded')
          const embedder = await make.ortEmbedder({ ort, buffer, provider: 'webgpu', backend: 'fp16 on WebGPU (worker)' })
          tried.push({ step: way, ok: true })
          return embedder
        }
        if (way === 'main-webgpu') {
          await rpc('load-model', { path: fp16 })
          tried.push({ step: way, ok: true })
          return make.remoteEmbedder({ backend: 'fp16 on WebGPU (main thread)', half: true, request: (tensors, half) => rpc('embed', { tensors, half }, tensors.map(tensor => tensor.buffer)) })
        }
        if (way === 'main-wasm') {
          await rpc('load-model', { path: int8Path, provider: 'wasm' })
          tried.push({ step: way, ok: true })
          return make.remoteEmbedder({ backend: 'uint8 on WebAssembly (main thread)', half: false, request: (tensors, half) => rpc('embed', { tensors, half }, tensors.map(tensor => tensor.buffer)) })
        }
        const ort = await loadWasm()
        const buffer = await files.read(int8Path)
        if (!buffer) throw new Error('the 8-bit model is not downloaded')
        const embedder = await make.ortEmbedder({ ort, buffer, provider: 'wasm', backend: 'uint8 on WebAssembly' })
        tried.push({ step: way, ok: true })
        return embedder
      } catch (error) {
        tried.push({ step: way, ok: false, note: `${error?.name && error.name !== 'Error' ? `${error.name}: ` : ''}${String(error?.message || error)}`.replace(/\s+/g, ' ').slice(0, 220) })
        if (way === 'wasm') throw error
      }
    }
    throw new Error('no embedding backend could start')
  }

  /** The reader's sessions: WebAssembly in this worker (default), or the two OCR models on the main thread's WebGPU, called over rpc. */
  async function chooseOcr(manifest, ocrBackend, tried) {
    if (ocrBackend === 'webgpu-main') {
      try {
        await rpc('ocr-load', {})
        const characters = characterTable(new TextDecoder().decode(await files.read('ocr/characters.txt')))
        const call = kind => async tensor => {
          const data = tensor.data.byteOffset === 0 && tensor.data.byteLength === tensor.data.buffer.byteLength ? tensor.data : tensor.data.slice()
          return rpc('ocr-run', { kind, data, dims: Array.from(tensor.dims) }, [data.buffer])
        }
        tried.push({ step: 'ocr webgpu (main thread)', ok: true })
        return { characters, detect: call('det'), recognise: call('rec'), where: 'main thread WebGPU', release: () => rpc('ocr-release', {}).catch(() => {}) }
      } catch (error) {
        tried.push({ step: 'ocr webgpu (main thread)', ok: false, note: String(error?.message || error).slice(0, 200) })
        await rpc('ocr-release', {}).catch(() => {})
      }
    }
    const buffers = await readAll(manifest, 'ocr/')
    const sessions = await make.createOcrSessions({ ort: await loadWasm(), det: buffers['ocr/det.onnx'], rec: buffers['ocr/rec.onnx'], characters: buffers['ocr/characters.txt'] })
    tried.push({ step: 'ocr wasm (worker)', ok: true })
    return { ...sessions, where: 'worker WebAssembly' }
  }

  async function release() {
    const { embedder, sessions } = state
    state.embedder = state.sessions = state.matcher = state.index = state.getIndexes = null
    state.ready = false
    await embedder?.release?.()
    await sessions?.release?.()
    if (embedder?.where === 'main thread' || sessions?.inner?.where === 'main thread WebGPU') await rpc('release-model', {}).catch(() => {})
  }

  async function init({ manifest, mode = 'auto', mainGpu = false, budgets = {}, ocrBackend = 'wasm', ocrProfile = 'server', detectMaxSide = null, lowMemory = false }) {
    const guard = checkManifest(manifest)
    if (!guard.ok) return { fail: guard }
    await release() // a second init replaces the first: one embedding model at a time
    const tried = []
    const began = now()
    state.lowMemory = Boolean(lowMemory)
    let resources = null
    if (lowMemory) {
      // Strictly one thing at a time: only the embedding model is loaded now. The picture index, the reader and the card-database indexes are
      // opened by the stage that needs them and released when it is done (matcher.js `lowMemory`).
      state.embedder = await chooseEmbedder(manifest, mode, mainGpu, tried)
      let ids = null // the ids of the picture index, kept (about 1 MB) so the card-database indexes can be restricted to it
      let lazyNow = null
      resources = {
        openIndex: async () => { const opened = make.pictureIndexFromBuffers(await readAll(manifest, 'index/')); ids = opened.ids; state.info && (state.info.pictures = opened.count); return opened },
        closeIndex: async () => {},
        openReader: async () => (state.sessions = recordSessions(await chooseOcr(manifest, ocrBackend, []), now)),
        closeReader: async () => { const old = state.sessions; state.sessions = null; await old?.release?.(); },
        closeDecide: async () => { lazyNow = null },
      }
      state.getIndexes = async () => {
        if (!cardDb || !(await cardDb.getMeta('en'))) return null
        lazyNow = lazyNow || make.createLazyIndexes({ source: cardDb, restrictToIds: ids })
        return lazyNow()
      }
    } else {
      state.embedder = await chooseEmbedder(manifest, mode, mainGpu, tried) // first: the GPU session is made before the other models fill the memory
      state.sessions = recordSessions(await chooseOcr(manifest, ocrBackend, tried), now)
      state.index = make.pictureIndexFromBuffers(await readAll(manifest, 'index/'))
      const lazy = cardDb ? make.createLazyIndexes({ source: cardDb, restrictToIds: state.index.ids }) : null
      state.getIndexes = async () => {
        if (!lazy || !(await cardDb.getMeta('en'))) return null // the offline card database is not downloaded on this phone
        return lazy()
      }
    }
    state.manifest = manifest
    state.matcher = make.createPhoneMatcher({
      embedder: state.embedder, index: state.index, sessions: state.sessions, getDecideIndexes: state.getIndexes, resources,
      thresholds: thresholdsFromManifest(manifest), budgets, now, detectMaxSide, ocr: OCR_PROFILES[ocrProfile] ?? {},
    })
    state.info = {
      backend: state.embedder.backend, where: state.embedder.where, mode, ocrBackend: lowMemory ? `${ocrBackend === 'webgpu-main' ? 'main thread WebGPU' : 'worker WebAssembly'} (opened per run)` : state.sessions.inner.where, ocrProfile, detectMaxSide, lowMemory: Boolean(lowMemory), tried, loadMs: Math.round(now() - began),
      pictures: state.index ? state.index.count : (manifest.index?.whole_count ?? null), artPictures: state.index ? state.index.artCount : (manifest.index?.art_count ?? null), thresholds: 'manifest',
      cardDb: cardDb ? Boolean(await cardDb.getMeta('en')) : false,
    }
    state.ready = true
    return { info: state.info }
  }

  async function match({ photo, options = {} }, id) {
    if (!state.ready) throw new Error('The matcher is not loaded')
    const picture = { data: photo.data instanceof Uint8ClampedArray ? photo.data : new Uint8ClampedArray(photo.data), width: photo.width, height: photo.height }
    const result = await state.matcher.match(picture, { ...options, lowMemory: state.lowMemory, onStage: (stage, info) => post({ type: 'progress', id, stage, ...(info ? { done: true, ms: info.ms } : {}) }) })
    // low memory: asking again would build the card-database indexes just to count them, so only say whether the database is there
    const indexes = state.lowMemory ? null : await state.getIndexes()
    if (state.lowMemory) { result.catalogue = { present: Boolean(cardDb && await cardDb.getMeta('en')), cards: null }; return result }
    result.catalogue = indexes ? { present: true, cards: indexes.count, printedTotalMissing: indexes.stats?.printedTotalMissing ?? null, buildMs: indexes.stats?.buildMs ?? null } : { present: false }
    return result
  }

  const fail = (id, error) => post({ type: 'error', id, code: error?.code ?? 'failed', message: String(error?.message || error).slice(0, 300) })

  /** One client message. Matches run one at a time, in the order they arrived. */
  function handle(message) {
    const { type, id } = message || {}
    if (type === 'rpc-result') {
      const call = waiting.get(message.callId)
      waiting.delete(message.callId)
      if (call) (message.error === undefined ? call.resolve(message.result) : call.reject(new Error(message.error)))
      return Promise.resolve()
    }
    const job = async () => {
      try {
        if (type === 'init') {
          const done = await init(message)
          if (done.fail) post({ type: 'error', id, code: done.fail.code, message: done.fail.message })
          else post({ type: 'ready', id, info: done.info })
        } else if (type === 'match') {
          post({ type: 'result', id, result: await match(message, id) })
        } else if (type === 'diag-gpu') {
          const rows = await diagnoseWebGpu({ nav: message.nav ?? undefined, loadGpu, readFile: path => files.read(path), path: message.path, onStep: (step, row) => post({ type: 'progress', id, stage: step, ...(row ? { done: true, ms: row.ms, ok: row.ok, note: row.note } : {}) }), now })
          post({ type: 'diag', id, rows })
        } else if (type === 'release') {
          await release()
          post({ type: 'released', id })
        } else {
          fail(id, new Error(`Unknown message ${type}`))
        }
      } catch (error) {
        fail(id, error)
      }
    }
    state.queue = state.queue.then(job)
    return state.queue
  }

  return { handle, state }
}
