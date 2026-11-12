// The page's side of the matcher worker: one object with `init`, `match` and `release`, promises for each, and the main-thread
// model for the case where the worker has no WebGPU (the host asks for it by `rpc`). A worker that cannot be created (or that
// dies) is reported as an error; `loopbackWorker` runs the same host in this scope, which the tests use.
import { serveEmbeddings } from './embedder'
import { SESSION_OPTIONS } from './ort'

export class MatcherError extends Error {
  constructor(message, code) { super(message); this.code = code }
}

/** The worker the page uses. */
export const defaultWorker = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })

/**
 * createMatcherClient({createWorker, readFile, loadGpu}) -> {init, match, release, terminate, info}
 *   createWorker()   -> a Worker-like {postMessage, onmessage, onerror, terminate}
 *   readFile(path)   -> ArrayBuffer | null   (for the fp16 model when it has to run on this thread)
 *   loadGpu()        -> the ORT WebGPU build (this thread)
 */
export function createMatcherClient({ createWorker = defaultWorker, readFile = async () => null, loadGpu = null } = {}) {
  let worker = null
  let nextId = 1
  const pending = new Map()
  const stageListeners = new Map()
  const models = new Map() // main-thread sessions by name: 'embed', 'det', 'rec'
  const client = { info: null }

  const dead = error => {
    for (const { reject } of pending.values()) reject(error)
    pending.clear()
    worker = null
  }

  async function openModel(name, path, shape = null) {
    const ort = await loadGpu()
    const buffer = await readFile(path)
    if (!buffer) throw new Error(`${path} is not downloaded`)
    const session = await ort.InferenceSession.create(new Uint8Array(buffer), { executionProviders: ['webgpu'], ...SESSION_OPTIONS })
    models.set(name, { path, session, ort, run: name === 'embed' ? await serveEmbeddings({ ort, session }) : null })
  }

  async function dropModels(names) {
    for (const name of names) {
      const old = models.get(name)
      models.delete(name)
      await old?.session?.release?.()
    }
  }

  async function serve(method, payload) {
    if (method === 'load-model') {
      if (models.get('embed')?.path === payload.path) return true // a restarted worker finds the model still loaded here
      await dropModels(['embed'])
      await openModel('embed', payload.path)
      return true
    }
    if (method === 'embed') {
      if (!models.has('embed')) throw new Error('no model on the main thread')
      return models.get('embed').run(payload.tensors)
    }
    if (method === 'ocr-load') { // the two reader models on WebGPU: an unsupported operator names itself in the error
      if (models.has('det') && models.has('rec')) return true
      await dropModels(['det', 'rec'])
      try {
        await openModel('det', 'ocr/det.onnx')
        await openModel('rec', 'ocr/rec.onnx')
      } catch (error) {
        await dropModels(['det', 'rec'])
        throw error
      }
      return true
    }
    if (method === 'ocr-run') {
      const model = models.get(payload.kind)
      if (!model) throw new Error('the OCR model is not loaded on the main thread')
      const { ort, session } = model
      const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', payload.data, payload.dims) })
      const value = out[session.outputNames[0]]
      const data = await value.getData()
      const result = { data: Float32Array.from(data), dims: [...value.dims] }
      value.dispose?.()
      return result
    }
    if (method === 'ocr-release') { await dropModels(['det', 'rec']); return true }
    if (method === 'release-model') { await dropModels([...models.keys()]); return true }
    throw new Error(`Unknown rpc ${method}`)
  }

  function start() {
    if (worker) return worker
    worker = createWorker()
    worker.onmessage = event => {
      const message = event.data || {}
      if (message.type === 'rpc') {
        serve(message.method, message.payload).then(
          result => worker?.postMessage({ type: 'rpc-result', callId: message.callId, result }),
          error => worker?.postMessage({ type: 'rpc-result', callId: message.callId, error: String(error?.message || error) }),
        )
        return
      }
      if (message.type === 'progress') { stageListeners.get(message.id)?.(message.stage, message.done ? { ms: message.ms } : null); return }
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      stageListeners.delete(message.id)
      if (message.type === 'error') entry.reject(new MatcherError(message.message, message.code))
      else entry.resolve(message)
    }
    worker.onerror = event => { event?.preventDefault?.(); dead(new MatcherError('The matcher worker failed', 'worker_failed')) }
    worker.onmessageerror = () => dead(new MatcherError('The matcher worker sent a message that could not be read', 'worker_failed'))
    return worker
  }

  const send = (message, transfer = [], onStage = null) => new Promise((resolve, reject) => {
    const id = nextId++
    let target
    try { target = start() } catch (error) { reject(new MatcherError(`Could not start the matcher worker: ${error.message}`, 'worker_failed')); return }
    pending.set(id, { resolve, reject })
    if (onStage) stageListeners.set(id, onStage)
    target.postMessage({ ...message, id }, transfer)
  })

  return Object.assign(client, {
    /** Loads the models and indexes in the worker. Rejects with `code: 'matcher_version'` for a bundle of another version. */
    async init({ manifest, mode = 'auto', mainGpu = false, budgets = {}, ocrBackend = 'wasm', ocrProfile = 'server', detectMaxSide = null, lowMemory = false }) {
      const reply = await send({ type: 'init', manifest, mode, mainGpu, budgets, ocrBackend, ocrProfile, detectMaxSide, lowMemory })
      client.info = reply.info
      return reply.info
    },
    /** `photo` = {data: Uint8ClampedArray RGBA, width, height}; its buffer is moved to the worker. */
    async match(photo, { onStage = null, useText = true, overlap = false } = {}) {
      const reply = await send({ type: 'match', photo, options: { useText, overlap } }, [photo.data.buffer], onStage)
      return reply.result
    },
    async release() { await send({ type: 'release' }); await serve('release-model') },
    /** Stops the worker (its wasm heaps and indexes go) but keeps the models on this thread: the next `init` starts a fresh worker. */
    restartWorker() {
      try { worker?.terminate() } catch { /* already gone */ }
      dead(new MatcherError('The matcher worker was restarted', 'terminated'))
    },
    terminate() {
      serve('release-model').catch(() => {})
      try { worker?.terminate() } catch { /* already gone */ }
      dead(new MatcherError('The matcher worker was stopped', 'terminated'))
    },
  })
}

/** A Worker-like object that runs `host` in this scope (tests, or a page without Worker support). Messages are copied like a real worker's. */
export function loopbackWorker(createHost) {
  const toWorker = message => {
    queueMicrotask(() => { try { host.handle(structuredClone(message)) } catch { /* the host answers errors itself */ } })
  }
  const fake = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: (message, transfer) => toWorker(message, transfer),
    terminate() {},
  }
  const host = createHost((message, transfer) => queueMicrotask(() => fake.onmessage?.({ data: message })), fake)
  return fake
}
