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
import { pictureIndexFromBuffers } from './pictureIndex'

export const MODES = ['auto', 'worker-webgpu', 'main-webgpu', 'wasm']

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
    if ((mode === 'auto' || mode === 'worker-webgpu') && gpuHere) order.push('worker-webgpu')
    if ((mode === 'auto' || mode === 'main-webgpu') && gpuMain) order.push('main-webgpu')
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
        const ort = await loadWasm()
        const buffer = await files.read(int8Path)
        if (!buffer) throw new Error('the 8-bit model is not downloaded')
        const embedder = await make.ortEmbedder({ ort, buffer, provider: 'wasm', backend: 'uint8 on WebAssembly' })
        tried.push({ step: way, ok: true })
        return embedder
      } catch (error) {
        tried.push({ step: way, ok: false, note: String(error?.message || error).slice(0, 160) })
        if (way === 'wasm') throw error
      }
    }
    throw new Error('no embedding backend could start')
  }

  async function release() {
    const { embedder, sessions } = state
    state.embedder = state.sessions = state.matcher = state.index = state.getIndexes = null
    state.ready = false
    await embedder?.release?.()
    await sessions?.release?.()
    if (embedder?.where === 'main thread') await rpc('release-model', {}).catch(() => {})
  }

  async function init({ manifest, mode = 'auto', mainGpu = false, budgets = {} }) {
    const guard = checkManifest(manifest)
    if (!guard.ok) return { fail: guard }
    await release() // a second init replaces the first: one embedding model at a time
    const tried = []
    const began = now()
    const sessionsBuffers = await readAll(manifest, 'ocr/')
    state.sessions = await make.createOcrSessions({ ort: await loadWasm(), det: sessionsBuffers['ocr/det.onnx'], rec: sessionsBuffers['ocr/rec.onnx'], characters: sessionsBuffers['ocr/characters.txt'] })
    state.index = make.pictureIndexFromBuffers(await readAll(manifest, 'index/'))
    state.embedder = await chooseEmbedder(manifest, mode, mainGpu, tried)
    const lazy = cardDb ? make.createLazyIndexes({ source: cardDb, restrictToIds: state.index.ids }) : null
    state.getIndexes = async () => {
      if (!lazy || !(await cardDb.getMeta('en'))) return null // the offline card database is not downloaded on this phone
      return lazy()
    }
    state.manifest = manifest
    state.matcher = make.createPhoneMatcher({
      embedder: state.embedder, index: state.index, sessions: state.sessions, getDecideIndexes: state.getIndexes,
      thresholds: thresholdsFromManifest(manifest), budgets, now,
    })
    state.info = {
      backend: state.embedder.backend, where: state.embedder.where, mode, tried, loadMs: Math.round(now() - began),
      pictures: state.index.count, artPictures: state.index.artCount, thresholds: 'manifest',
      cardDb: cardDb ? Boolean(await cardDb.getMeta('en')) : false,
    }
    state.ready = true
    return { info: state.info }
  }

  async function match({ photo, options = {} }, id) {
    if (!state.ready) throw new Error('The matcher is not loaded')
    const picture = { data: photo.data instanceof Uint8ClampedArray ? photo.data : new Uint8ClampedArray(photo.data), width: photo.width, height: photo.height }
    const result = await state.matcher.match(picture, { ...options, onStage: stage => post({ type: 'progress', id, stage }) })
    const indexes = await state.getIndexes()
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
