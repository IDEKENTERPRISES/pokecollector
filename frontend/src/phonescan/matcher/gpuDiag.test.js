import { describe, expect, it } from 'vitest'
import { diagnoseWebGpu, summariseDiagnosis } from './gpuDiag'

const fakeOrt = (failAt = null) => ({
  Tensor: class { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims } },
  InferenceSession: {
    async create() {
      if (failAt === 'session') throw Object.assign(new Error('Failed to create the WebGPU backend: out of memory'), { name: 'RangeError' })
      return {
        inputNames: ['x'], outputNames: ['y'], inputMetadata: [{ type: 'float16' }],
        async run() { if (failAt === 'run') throw new Error('device lost'); return { y: { type: 'float32', dims: [1, 257, 4], async getData() { return new Float32Array(257 * 4).fill(1) } } } },
        async release() {},
      }
    },
  },
})
const nav = () => ({ gpu: { async requestAdapter() { return { info: { vendor: 'apple', architecture: 'common-3' }, async requestDevice() { return { limits: { maxBufferSize: 1073741824, maxStorageBufferBindingSize: 134217728 }, destroy() {} } } } } } })

describe('WebGPU step by step', () => {
  it('lists every step with its time and a note when all of them work', async () => {
    const events = []
    const rows = await diagnoseWebGpu({ nav: nav(), loadGpu: async () => fakeOrt(), readFile: async () => new ArrayBuffer(42 * 1048576), path: 'model/h.onnx', onStep: (step, row) => events.push(row ? `${step}:end` : `${step}:start`) })
    expect(rows.map(row => row.step)).toEqual(['navigator.gpu', 'adapter', 'device', 'runtime', 'model file', 'session', 'first embedding', 'second embedding', 'release'])
    expect(rows.every(row => row.ok)).toBe(true)
    expect(rows[1].note).toBe('apple / common-3')
    expect(rows[2].note).toMatch(/maxBufferSize 1024 MB/)
    expect(rows[4].note).toBe('42 MB')
    expect(rows[5].note).toBe('float16 input')
    expect(events.slice(0, 4)).toEqual(['navigator.gpu:start', 'navigator.gpu:end', 'adapter:start', 'adapter:end']) // a start is reported before the work, so a dead page names its step
  })

  it('stops at the first failure and keeps the real error with its name', async () => {
    const rows = await diagnoseWebGpu({ nav: nav(), loadGpu: async () => fakeOrt('session'), readFile: async () => new ArrayBuffer(8), path: 'm' })
    expect(rows.at(-1)).toMatchObject({ step: 'session', ok: false })
    expect(rows.at(-1).note).toMatch(/RangeError: Failed to create the WebGPU backend: out of memory/)
    expect(rows.map(row => row.step)).not.toContain('first embedding')
    expect(summariseDiagnosis(rows)).toMatch(/session FAILED: RangeError/)
  })

  it('says when there is no navigator.gpu, no adapter, or a model that is not downloaded', async () => {
    expect((await diagnoseWebGpu({ nav: {}, loadGpu: async () => fakeOrt(), readFile: async () => null, path: 'm' }))[0]).toMatchObject({ ok: false, note: 'navigator.gpu does not exist here' })
    const none = await diagnoseWebGpu({ nav: { gpu: { requestAdapter: async () => null } }, loadGpu: async () => fakeOrt(), readFile: async () => null, path: 'm' })
    expect(none.at(-1)).toMatchObject({ step: 'adapter', ok: false })
    const missing = await diagnoseWebGpu({ nav: nav(), loadGpu: async () => fakeOrt(), readFile: async () => null, path: 'model/h.onnx' })
    expect(missing.at(-1)).toMatchObject({ step: 'model file', ok: false, note: 'model/h.onnx is not downloaded' })
  })

  it('a failing embedding is reported as such (a device lost on the first run)', async () => {
    const rows = await diagnoseWebGpu({ nav: nav(), loadGpu: async () => fakeOrt('run'), readFile: async () => new ArrayBuffer(8), path: 'm' })
    expect(rows.at(-1)).toMatchObject({ step: 'first embedding', ok: false, note: 'device lost' })
  })
})
