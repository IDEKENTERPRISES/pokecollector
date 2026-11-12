// The worker message protocol (step 3d): the host and the client talk through a loopback "worker" (messages are structured-cloned like a
// real worker's), with fake ORT, sessions and matcher so only the protocol, the backend choice and the memory rules are under test.
import { describe, expect, it } from 'vitest'
import { createMatcherClient, loopbackWorker, MatcherError } from './client'
import { checkManifest, MATCHER_VERSION } from './guard'
import { createMatcherHost } from './host'

const manifest = (over = {}) => ({
  matcher_version: 11,
  thresholds: { sim_min_with_rules: 0.55, orient_margin: 0.1 },
  model: { file: 'model/model_quantized.onnx', webgpu_candidate: { file: 'model/model_fp16.onnx', in_bundle: true } },
  files: [
    { path: 'model/model_quantized.onnx' }, { path: 'model/model_fp16.onnx' }, { path: 'ocr/det.onnx' }, { path: 'ocr/rec.onnx' }, { path: 'ocr/characters.txt' },
    { path: 'index/whole/sv1.bin' }, { path: 'index/art/sv1.bin' },
  ],
  ...over,
})

/** A host with every environment piece faked; `log` records what happened in order. */
function setup({ workerGpu = false, mainGpu = false, cardDb = true, failGpu = false, files = null } = {}) {
  const log = []
  const reads = []
  const ort = name => ({ name, Tensor: class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims } }, InferenceSession: {
    async create(buffer, options) {
      log.push(`session:${name}:${options.executionProviders[0]}`)
      return {
        inputNames: ['pixel_values'], outputNames: ['out'], inputMetadata: [{ type: options.executionProviders[0] === 'webgpu' ? 'float16' : 'float32' }],
        async run() { return { out: { type: 'float32', dims: [1, 257, 8], async getData() { return Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0].concat(new Array(8 * 256).fill(0))) } } } },
        async release() { log.push(`release:${name}`) },
      }
    },
  } })
  const embedderFactory = async ({ provider, backend }) => {
    log.push(`embedder:${provider}`)
    return { backend, where: 'here', embed: async images => images.map(() => Float32Array.of(1, 0)), release: async () => log.push(`release-embedder:${provider}`) }
  }
  const host = (post, fake) => createMatcherHost({
    post,
    files: { async read(path) { reads.push(path); return files ? files(path) : new ArrayBuffer(8) } },
    loadWasm: async () => ort('wasm'),
    loadGpu: async () => { if (failGpu) throw new Error('webgpu is not here'); return ort('gpu') },
    probeGpu: async () => (workerGpu ? { available: true, reason: null } : { available: false, reason: 'navigator.gpu does not exist here' }),
    cardDb: cardDb ? { getMeta: async () => ({ hash: 'h1', sets: 3 }) } : { getMeta: async () => null },
    now: (() => { let t = 0; return () => (t += 10) })(),
    build: {
      ortEmbedder: embedderFactory,
      createOcrSessions: async () => ({ characters: [], release: async () => log.push('release-ocr') }),
      pictureIndexFromBuffers: () => ({ ids: ['a_en', 'b_en'], count: 2, artCount: 2 }),
      createLazyIndexes: () => async () => ({ count: 2, stats: { printedTotalMissing: 0, buildMs: 5 } }),
      createPhoneMatcher: ({ embedder, getDecideIndexes }) => ({
        async match(photo, { onStage }) {
          onStage?.('finder')
          const vectors = await embedder.embed([{ data: new Uint8ClampedArray(8 * 8 * 4), width: 8, height: 8 }])
          onStage?.('decide')
          const indexes = await getDecideIndexes()
          return { version: 11, backend: embedder.backend, photoSize: [photo.width, photo.height], vector: Array.from(vectors[0].slice(0, 2)), hasCatalogue: Boolean(indexes), decided: false, timings_ms: {} }
        },
      }),
    },
  })
  const created = []
  const client = createMatcherClient({
    createWorker: () => { const worker = loopbackWorker(host); created.push(worker); return worker },
    readFile: async () => new ArrayBuffer(8),
    loadGpu: async () => ort('main-gpu'),
  })
  return { client, log, reads, created }
}

describe('the version guard', () => {
  it('accepts the version the code was written for and a complete bundle', () => {
    expect(MATCHER_VERSION).toBe(11)
    expect(checkManifest(manifest())).toEqual({ ok: true })
  })
  it('refuses another matcher version with a clear "needs updating" message', () => {
    for (const version of [10, 12, '10', null, undefined]) {
      const guard = checkManifest(manifest({ matcher_version: version }))
      expect(guard.ok).toBe(false)
      expect(guard.code).toBe('matcher_version')
      expect(guard.message).toMatch(/needs updating/i)
      expect(guard.codeVersion).toBe(11)
    }
  })
  it('refuses a missing manifest and a bundle without its models or indexes', () => {
    expect(checkManifest(null).code).toBe('no_manifest')
    const missing = checkManifest(manifest({ files: [{ path: 'ocr/det.onnx' }] }))
    expect(missing).toMatchObject({ ok: false, code: 'incomplete' })
    expect(missing.message).toMatch(/8-bit model/)
  })
})

describe('starting the matcher', () => {
  it('uses uint8 on WebAssembly when there is no WebGPU, and never touches the WebGPU build', async () => {
    const { client, log } = setup()
    const info = await client.init({ manifest: manifest(), mode: 'auto', mainGpu: false })
    expect(info.backend).toBe('uint8 on WebAssembly')
    expect(log).toContain('embedder:wasm')
    expect(log.filter(entry => entry.includes('webgpu') || entry.includes('gpu'))).toEqual([])
    expect(info.cardDb).toBe(true)
    expect(info.pictures).toBe(2)
    expect(info.tried.map(step => step.step)).toEqual(['probe worker WebGPU', 'wasm'])
  })

  it('uses fp16 on WebGPU in the worker when the worker has WebGPU', async () => {
    const { client, reads } = setup({ workerGpu: true })
    const info = await client.init({ manifest: manifest(), mode: 'auto', mainGpu: true })
    expect(info.backend).toBe('fp16 on WebGPU (worker)')
    expect(reads).toContain('model/model_fp16.onnx')
    expect(reads).not.toContain('model/model_quantized.onnx') // the 8-bit model is not even read: never uint8 on WebGPU, one model at a time
  })

  it('runs the model on the main thread with WebGPU when only the main thread has it, the rest staying in the worker', async () => {
    const { client } = setup({ workerGpu: false })
    const info = await client.init({ manifest: manifest(), mode: 'auto', mainGpu: true })
    expect(info.backend).toBe('fp16 on WebGPU (main thread)')
    expect(info.where).toBe('main thread')
    const result = await client.match({ data: new Uint8ClampedArray(16), width: 2, height: 2 })
    expect(result.vector[0]).toBeCloseTo(1, 5) // the vector came back from the main thread's model (a unit vector)
    expect(result.backend).toBe('fp16 on WebGPU (main thread)')
  })

  it('falls back from a WebGPU that fails to start to WebAssembly, and says what it tried', async () => {
    const { client } = setup({ workerGpu: true, failGpu: true })
    const info = await client.init({ manifest: manifest(), mode: 'auto', mainGpu: false })
    expect(info.backend).toBe('uint8 on WebAssembly')
    const gpu = info.tried.find(step => step.step === 'worker-webgpu')
    expect(gpu).toMatchObject({ ok: false })
    expect(gpu.note).toMatch(/webgpu is not here/)
  })

  it('honours a forced mode, and a forced WebGPU mode without WebGPU still ends on WebAssembly', async () => {
    const forced = setup({ workerGpu: true })
    expect((await forced.client.init({ manifest: manifest(), mode: 'wasm', mainGpu: true })).backend).toBe('uint8 on WebAssembly')
    const missing = setup({ workerGpu: false })
    expect((await missing.client.init({ manifest: manifest(), mode: 'worker-webgpu', mainGpu: false })).backend).toBe('uint8 on WebAssembly')
  })

  it('does not hold two models: a second init releases the first embedder, then loads the next', async () => {
    const { client, log } = setup({ workerGpu: true })
    await client.init({ manifest: manifest(), mode: 'worker-webgpu' })
    await client.init({ manifest: manifest(), mode: 'wasm' })
    expect(log.indexOf('release-embedder:webgpu')).toBeGreaterThan(-1)
    expect(log.indexOf('release-embedder:webgpu')).toBeLessThan(log.indexOf('embedder:wasm'))
    expect(log.filter(entry => entry === 'release-ocr')).toHaveLength(1)
  })

  it('refuses a bundle of another version before reading any file, with the "needs updating" code', async () => {
    const { client, reads } = setup()
    await expect(client.init({ manifest: manifest({ matcher_version: 12 }) })).rejects.toMatchObject({ code: 'matcher_version' })
    expect(reads).toEqual([])
  })

  it('names a file that is not downloaded', async () => {
    const { client } = setup({ files: path => (path === 'ocr/rec.onnx' ? null : new ArrayBuffer(8)) })
    await expect(client.init({ manifest: manifest() })).rejects.toThrow(/ocr\/rec\.onnx is not downloaded/)
  })
})

describe('matching through the worker', () => {
  it('returns the result, reports each stage as it starts, and moves the photo buffer to the worker', async () => {
    const { client } = setup()
    await client.init({ manifest: manifest() })
    const stages = []
    const photo = { data: new Uint8ClampedArray(2 * 3 * 4), width: 2, height: 3 }
    const result = await client.match(photo, { onStage: stage => stages.push(stage) })
    expect(stages).toEqual(['finder', 'decide'])
    expect(result.photoSize).toEqual([2, 3])
    expect(result.hasCatalogue).toBe(true)
    expect(result.catalogue).toEqual({ present: true, cards: 2, printedTotalMissing: 0, buildMs: 5 })
  })

  it('says plainly that the card database is not on the phone (picture-only run)', async () => {
    const { client } = setup({ cardDb: false })
    const info = await client.init({ manifest: manifest() })
    expect(info.cardDb).toBe(false)
    const result = await client.match({ data: new Uint8ClampedArray(16), width: 2, height: 2 })
    expect(result.catalogue).toEqual({ present: false })
    expect(result.hasCatalogue).toBe(false)
  })

  it('answers several matches one at a time, in order', async () => {
    const { client } = setup()
    await client.init({ manifest: manifest() })
    const sizes = await Promise.all([1, 2, 3].map(n => client.match({ data: new Uint8ClampedArray(n * 4), width: n, height: 1 }).then(result => result.photoSize[0])))
    expect(sizes).toEqual([1, 2, 3])
  })

  it('refuses to match before init and after release', async () => {
    const { client } = setup()
    await expect(client.match({ data: new Uint8ClampedArray(4), width: 1, height: 1 })).rejects.toThrow(/not loaded/)
    await client.init({ manifest: manifest() })
    await client.release()
    await expect(client.match({ data: new Uint8ClampedArray(4), width: 1, height: 1 })).rejects.toThrow(/not loaded/)
  })

  it('release frees the embedder and the reader sessions', async () => {
    const { client, log } = setup()
    await client.init({ manifest: manifest() })
    await client.release()
    expect(log).toContain('release-embedder:wasm')
    expect(log).toContain('release-ocr')
  })

  it('releases the main-thread model with the rest', async () => {
    const { client, log } = setup()
    await client.init({ manifest: manifest(), mode: 'auto', mainGpu: true })
    await client.release()
    expect(log).toContain('release:main-gpu')
  })
})

describe('a worker that cannot start or that dies', () => {
  it('rejects init with a clear error when the worker cannot be created', async () => {
    const client = createMatcherClient({ createWorker: () => { throw new Error('no workers here') } })
    await expect(client.init({ manifest: manifest() })).rejects.toMatchObject({ code: 'worker_failed' })
  })

  it('rejects what is in flight when the worker fails', async () => {
    let fake
    const client = createMatcherClient({ createWorker: () => (fake = { postMessage() {}, terminate() {} }) })
    const pending = client.init({ manifest: manifest() })
    fake.onerror({ preventDefault() {} })
    await expect(pending).rejects.toBeInstanceOf(MatcherError)
    await expect(pending).rejects.toMatchObject({ code: 'worker_failed' })
  })

  it('terminate stops everything in flight', async () => {
    const client = createMatcherClient({ createWorker: () => ({ postMessage() {}, terminate() {} }) })
    const pending = client.init({ manifest: manifest() })
    client.terminate()
    await expect(pending).rejects.toMatchObject({ code: 'terminated' })
  })
})
