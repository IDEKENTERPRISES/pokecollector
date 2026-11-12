// onnxruntime-web for the matcher, loaded on demand and usable from a Web Worker or the main thread (the page's `runtime.js`
// of the speed test uses `window.location`; a worker has `self.location`, so the wasm paths are resolved against `globalThis.location`).
// Single-threaded (the app is not cross-origin isolated). The two builds are separate modules: the plain WebAssembly build
// (the 8-bit model, OCR) and the build with the WebGPU provider (the fp16 model; its own asyncify wasm).
import { ORT_VERSION } from '../../phonespeed/plan'

export { ORT_VERSION }

let wasmRuntime = null
let gpuRuntime = null

const here = () => globalThis.location?.href ?? 'http://localhost/'

export function loadWasmRuntime() {
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
