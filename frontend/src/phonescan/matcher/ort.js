// onnxruntime-web for the matcher, loaded on demand and usable from a Web Worker or the main thread (the page's `runtime.js`
// of the speed test uses `window.location`; a worker has `self.location`, so the wasm paths are resolved against `globalThis.location`).
// Single-threaded (the app is not cross-origin isolated). The two builds are separate modules: the plain WebAssembly build
// (the 8-bit model, OCR) and the build with the WebGPU provider (the fp16 model; its own asyncify wasm).
import { ORT_VERSION } from '../../phonespeed/plan'

export { ORT_VERSION }

let wasmRuntime = null
let gpuRuntime = null

const here = () => globalThis.location?.href ?? 'http://localhost/'

// -- WebAssembly heaps -------------------------------------------------------------------------------------------------------------------
// onnxruntime-web keeps its wasm Memory to itself, and a wasm heap never shrinks. To see how big the heaps are (per stage, per run) every instantiation in this
// scope is wrapped once, BEFORE onnxruntime-web is imported, and the exported memories are remembered.
const memories = []
let tracking = false

export function trackWasmMemory(wasm = globalThis.WebAssembly) {
  if (tracking || !wasm?.instantiate) return false
  tracking = true
  const remember = result => {
    try {
      const instance = result?.instance ?? result
      const memory = instance?.exports?.memory
      if (memory && typeof memory.buffer !== 'undefined') memories.push(memory)
    } catch { /* not an instance */ }
    return result
  }
  const instantiate = wasm.instantiate.bind(wasm)
  wasm.instantiate = (...args) => instantiate(...args).then(remember)
  if (wasm.instantiateStreaming) {
    const streaming = wasm.instantiateStreaming.bind(wasm)
    wasm.instantiateStreaming = (...args) => streaming(...args).then(remember)
  }
  return true
}

/** The size of every WebAssembly heap in this scope, in MB (the total and each one): they only ever grow. */
export function wasmHeapMB() {
  const sizes = memories.map(memory => { try { return Math.round(memory.buffer.byteLength / 1048576 * 10) / 10 } catch { return 0 } })
  return { total: Math.round(sizes.reduce((sum, value) => sum + value, 0) * 10) / 10, each: sizes }
}

/** An out-of-memory error from ORT, the WebAssembly runtime or the allocator, by its words. Such a scope is spent: a heap never shrinks and an aborted module stays aborted. */
export function isOutOfMemory(error) {
  const text = `${error?.name ?? ''} ${error?.message ?? error ?? ''}`.toLowerCase()
  return /out of memory|\boom\b|aborted\(oom|memory access out of bounds|failed to allocate|allocation failed|array buffer allocation|bad_alloc|cannot enlarge memory|could not allocate|insufficient memory|rangeerror.*(buffer|memory)|aborted\(\)|runtimeerror: abort/.test(text)
}

/** Destroys the WebGPU device ORT made (its buffers go with it). Only for a deliberate release or a recovery: a destroyed device cannot be used again in this page. */
export async function destroyGpuDevice(ort) {
  try {
    const device = await ort?.env?.webgpu?.device
    device?.destroy?.()
    return Boolean(device)
  } catch {
    return false
  }
}

export function loadWasmRuntime() {
  trackWasmMemory()
  if (!wasmRuntime) {
    wasmRuntime = (async () => {
      const [ort, wasm] = await Promise.all([import('onnxruntime-web/wasm'), import('onnxruntime-web/ort-wasm-simd-threaded.wasm?url')])
      ort.env.wasm.numThreads = 1
      ort.env.wasm.proxy = false
      ort.env.wasm.wasmPaths = { wasm: new URL(wasm.default, here()).href }
      return ort
    })().catch(error => { wasmRuntime = null; throw error })
  }
  return wasmRuntime
}

export function loadGpuRuntime() {
  trackWasmMemory()
  if (!gpuRuntime) {
    gpuRuntime = (async () => {
      const [ort, wasm] = await Promise.all([import('onnxruntime-web/webgpu'), import('onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url')])
      ort.env.wasm.numThreads = 1
      ort.env.wasm.proxy = false
      ort.env.wasm.wasmPaths = { wasm: new URL(wasm.default, here()).href }
      return ort
    })().catch(error => { gpuRuntime = null; throw error })
  }
  return gpuRuntime
}

/** Does WebGPU really work in this scope (a window or a worker)? `navigator.gpu` can exist and still hand out no adapter. */
export async function probeWebGpu(nav = globalThis.navigator) {
  if (!nav?.gpu) return { available: false, reason: 'navigator.gpu does not exist here' }
  try {
    const adapter = await nav.gpu.requestAdapter()
    return adapter ? { available: true, reason: null } : { available: false, reason: 'no WebGPU adapter' }
  } catch (error) {
    return { available: false, reason: String(error?.message || error).slice(0, 120) }
  }
}

export const SESSION_OPTIONS = { graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false }

const watched = new WeakSet()

/**
 * Writes the WebGPU device's own trouble to `emit(text)`: "device lost" (with its reason) and uncaptured errors. ORT shares one device between sessions, so each device
 * is watched once. Returns true when a device was found. Used on both threads so a run that dies leaves a reason behind, not only a stage.
 */
export async function watchGpu(ort, emit) {
  try {
    const device = await ort.env?.webgpu?.device
    if (!device || watched.has(device)) return Boolean(device)
    watched.add(device)
    device.lost?.then(info => emit(`device lost (${info?.reason ?? '?'}): ${String(info?.message ?? '').slice(0, 120)}`))
    device.addEventListener?.('uncapturederror', event => emit(`uncaptured GPU error: ${String(event?.error?.message || event?.error || '').slice(0, 120)}`))
    return true
  } catch {
    return false
  }
}
