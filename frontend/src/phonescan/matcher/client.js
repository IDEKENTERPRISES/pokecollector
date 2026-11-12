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
  let mainModel = null
  const client = { info: null }

  const dead = error => {
    for (const { reject } of pending.values()) reject(error)
    pending.clear()
    worker = null
  }

  async function serve(method, payload) {
    if (method === 'load-model') {
      await serve('release-model')
      const ort = await loadGpu()
      const buffer = await readFile(payload.path)
      if (!buffer) throw new Error('the fp16 model is not downloaded')
      const session = await ort.InferenceSession.create(new Uint8Array(buffer), { executionProviders: ['webgpu'], ...SESSION_OPTIONS })
      mainModel = { session, run: await serveEmbeddings({ ort, session }) }
      return true
    }
    if (method === 'embed') {
      if (!mainModel) throw new Error('no model on the main thread')
      return mainModel.run(payload.tensors)
    }
    if (method === 'release-model') {
      const old = mainModel
      mainModel = null
      await old?.session?.release?.()
      return true
    }
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
      if (message.type === 'progress') { stageListeners.get(message.id)?.(message.stage); return }
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
    async init({ manifest, mode = 'auto', mainGpu = false, budgets = {} }) {
      const reply = await send({ type: 'init', manifest, mode, mainGpu, budgets })
      client.info = reply.info
      return reply.info
    },
    /** `photo` = {data: Uint8ClampedArray RGBA, width, height}; its buffer is moved to the worker. */
    async match(photo, { onStage = null, useText = true } = {}) {
      const reply = await send({ type: 'match', photo, options: { useText } }, [photo.data.buffer], onStage)
      return reply.result
    },
    async release() { await send({ type: 'release' }); await serve('release-model') },
    terminate() {
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
