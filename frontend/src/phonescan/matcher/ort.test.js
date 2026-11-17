import { describe, expect, it } from 'vitest'
import { destroyGpuDevice, isOutOfMemory, trackWasmMemory, wasmHeapMB } from './ort'

describe('recognising an out-of-memory error', () => {
  it('knows the words ORT, the WebAssembly runtime and the allocator use', () => {
    for (const message of [
      'Aborted(OOM). Build with -sASSERTIONS for more info.', 'RangeError: Array buffer allocation failed', 'Out of memory', 'memory access out of bounds',
      'failed to allocate 40960000 bytes', 'std::bad_alloc', 'Aborted(). Build with -sASSERTIONS', 'RuntimeError: abort(OOM)', 'Cannot enlarge memory arrays',
    ]) expect(isOutOfMemory(new Error(message)), message).toBe(true)
    expect(isOutOfMemory(Object.assign(new Error('x'), { name: 'RangeError' }))).toBe(false)
    expect(isOutOfMemory('The 8-bit model is not downloaded')).toBe(false)
    expect(isOutOfMemory(new Error('Unsupported op: HardSwish'))).toBe(false)
    expect(isOutOfMemory(null)).toBe(false)
  })
})

describe('the WebAssembly heap sizes', () => {
  it('remembers the memory every instantiation exports and sums them in MB', async () => {
    const memory = { buffer: { byteLength: 64 * 1048576 } }
    const second = { buffer: { byteLength: 16 * 1048576 } }
    const fake = {
      instantiate: async () => ({ instance: { exports: { memory } } }),
      instantiateStreaming: async () => ({ instance: { exports: { memory: second } } }),
    }
    expect(trackWasmMemory(fake)).toBe(true)
    expect(trackWasmMemory(fake)).toBe(false) // wrapped once
    await fake.instantiate()
    await fake.instantiateStreaming()
    expect(wasmHeapMB()).toEqual({ total: 80, each: [64, 16] })
    memory.buffer = { byteLength: 96 * 1048576 } // a heap grows and never shrinks
    expect(wasmHeapMB().total).toBe(112)
  })
})

describe('destroying the GPU device', () => {
  it('destroys the device ORT made, and says so; with none it does nothing', async () => {
    let destroyed = 0
    expect(await destroyGpuDevice({ env: { webgpu: { device: Promise.resolve({ destroy: () => { destroyed += 1 } }) } } })).toBe(true)
    expect(destroyed).toBe(1)
    expect(await destroyGpuDevice({ env: {} })).toBe(false)
    expect(await destroyGpuDevice(null)).toBe(false)
  })
})
