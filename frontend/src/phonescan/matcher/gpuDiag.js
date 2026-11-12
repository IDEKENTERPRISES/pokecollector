// WebGPU, step by step, in one scope (a window or a worker): is there `navigator.gpu`, an adapter, a device, the ORT WebGPU runtime, the fp16 model's session, a first and a
// second embedding. Each step reports start and end (so a page that dies names the step it died in) and the first failure stops the list with the real error.
// Used by the speed-test page's "Test WebGPU" buttons, in the worker and on the main thread, to find out why the matcher's WebGPU path fails or crashes where the
// step 2 speed test's did not.
import { SESSION_OPTIONS } from './ort'
import { embedTensor, wantsHalf } from './embedder'

const message = error => `${error?.name && error.name !== 'Error' ? `${error.name}: ` : ''}${String(error?.message || error)}`.replace(/\s+/g, ' ').slice(0, 220)

/**
 * diagnoseWebGpu({nav, loadGpu, readFile, path, onStep, now}) -> [{step, ok, ms, note}] (stops at the first failure).
 *   onStep(step, null) when a step starts and onStep(step, {ok, ms, note}) when it ends.
 */
export async function diagnoseWebGpu({ nav = globalThis.navigator, loadGpu, readFile, path, onStep = null, now = () => performance.now() }) {
  const rows = []
  let adapter = null
  let ort = null
  let session = null
  const run = async (step, fn) => {
    onStep?.(step, null)
    const began = now()
    try {
      const note = await fn()
      const row = { step, ok: true, ms: Math.round(now() - began), note: note ?? null }
      rows.push(row)
      onStep?.(step, row)
      return true
    } catch (error) {
      const row = { step, ok: false, ms: Math.round(now() - began), note: message(error) }
      rows.push(row)
      onStep?.(step, row)
      return false
    }
  }
  const steps = [
    ['navigator.gpu', async () => { if (!nav?.gpu) throw new Error('navigator.gpu does not exist here') }],
    ['adapter', async () => {
      adapter = await nav.gpu.requestAdapter()
      if (!adapter) throw new Error('requestAdapter gave nothing')
      const info = adapter.info || {}
      return [info.vendor, info.architecture, info.description].filter(Boolean).join(' / ') || 'adapter found'
    }],
    ['device', async () => {
      const device = await adapter.requestDevice()
      const note = `maxBufferSize ${Math.round((device.limits?.maxBufferSize ?? 0) / 1048576)} MB, storage binding ${Math.round((device.limits?.maxStorageBufferBindingSize ?? 0) / 1048576)} MB`
      device.destroy?.()
      return note
    }],
    ['runtime', async () => { ort = await loadGpu() }],
    ['model file', async () => {
      const buffer = await readFile(path)
      if (!buffer) throw new Error(`${path} is not downloaded`)
      session = { buffer }
      return `${Math.round(buffer.byteLength / 1048576)} MB`
    }],
    ['session', async () => {
      const bytes = new Uint8Array(session.buffer)
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], ...SESSION_OPTIONS })
      return wantsHalf(session) ? 'float16 input' : 'float32 input'
    }],
    ['first embedding', async () => { await embedTensor(ort, session, new Float32Array(3 * 224 * 224), wantsHalf(session)) }],
    ['second embedding', async () => { await embedTensor(ort, session, new Float32Array(3 * 224 * 224), wantsHalf(session)) }],
    ['release', async () => { await session.release?.(); session = null }],
  ]
  for (const [step, fn] of steps) if (!(await run(step, fn))) break
  try { await session?.release?.() } catch { /* nothing to release */ }
  return rows
}

/** One line for the posted run and the page: "adapter ok · device ok · session FAILED: ...". */
export function summariseDiagnosis(rows) {
  return rows.map(row => (row.ok ? `${row.step} ok` : `${row.step} FAILED: ${row.note}`)).join(' · ').slice(0, 200)
}
