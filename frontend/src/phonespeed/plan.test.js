import { describe, expect, it } from 'vitest'
import {
  clearPartial, crashedRunBody, reportPreviousCrash, describeIos, loadPartial, markStep, newPartial, parseDevice, phaseOrder, previousCrash, recordStep, timingsOf,
} from './plan'

class MemoryStorage {
  constructor() { this.map = new Map() }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null }
  setItem(key, value) { this.map.set(key, String(value)) }
  removeItem(key) { this.map.delete(key) }
}

const UA_26 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1'
const UA_18 = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1'

describe('device facts', () => {
  it('reads the real iOS version from Safari 26 on, where the user agent freezes the OS at 18.x', () => {
    const device = parseDevice({ userAgent: UA_26, gpu: {}, hardwareConcurrency: 4 }, { crossOriginIsolated: false })
    expect(device).toMatchObject({ ios: '26.6', ios_raw: '18.7', safari: '26.6', gpu: true, crossOriginIsolated: false, hardwareConcurrency: 4 })
    expect(device.ua).toBe(UA_26) // the raw user agent is kept for the stored run
    expect(describeIos(device)).toBe('iOS 26.6 (user agent says 18.7)')
  })

  it('keeps the user agent version before Safari 26', () => {
    const device = parseDevice({ userAgent: UA_18 }, {})
    expect(device).toMatchObject({ ios: '18.2', ios_raw: '18.2', safari: '18.2', gpu: false })
    expect(describeIos(device)).toBe('iOS 18.2')
    expect(describeIos(parseDevice({ userAgent: 'curl' }, {}))).toBe('iOS ?')
  })
})

describe('step order', () => {
  it('runs every WebAssembly step before WebGPU, with fp16 on WebGPU last', () => {
    expect(phaseOrder({ webgpu: true })).toEqual(['photo', 'preprocess', 'wasm', 'index', 'ocr', 'webgpu_fp16'])
    expect(phaseOrder()).toEqual(phaseOrder({ webgpu: true }))
    expect(phaseOrder({ webgpu: false })).toEqual(['photo', 'preprocess', 'wasm', 'index', 'ocr'])
  })

  it('never runs the 8-bit model on WebGPU, which crashes Safari on iOS 26.6, whatever options are passed', () => {
    expect(phaseOrder({ webgpu: true, uint8Gpu: true })).not.toContain('webgpu_uint8')
    expect(phaseOrder({ webgpu: true, uint8Gpu: true }).at(-1)).toBe('webgpu_fp16')
  })
})

describe('crash flag and partial results', () => {
  it('saves every finished step at once, so a crash keeps what was done', () => {
    const storage = new MemoryStorage()
    const partial = newPartial({ ios: '26.6', gpu: true })
    recordStep(partial, 'session_wasm', { first: 900.04, median: 700.06, runs: [1, 2] }, storage)
    markStep('embed_wasm', storage)
    expect(loadPartial(storage).rows.session_wasm).toEqual({ first: 900.04, median: 700.06 })
    recordStep(partial, 'embed_wasm', { first: 400, median: 380 }, storage)
    recordStep(partial, 'session_webgpu_fp16', { error: 'x'.repeat(500) }, storage)
    const saved = loadPartial(storage)
    expect(Object.keys(saved.rows)).toEqual(['session_wasm', 'embed_wasm', 'session_webgpu_fp16'])
    expect(saved.rows.session_webgpu_fp16.error).toHaveLength(120)
    expect(saved.device.ios).toBe('26.6')
  })

  it('turns the flag and the partial run into a posted run with crashed_step, device facts and no photo', () => {
    const storage = new MemoryStorage()
    const partial = newPartial({ ios: '26.6', ios_raw: '18.7', gpu: true })
    recordStep(partial, 'session_wasm', { first: 900, median: 700 }, storage)
    recordStep(partial, 'embed_wasm', { first: 410.26, median: 399.94 }, storage)
    markStep('card_webgpu_uint8', storage)
    expect(previousCrash(storage)).toBe('card_webgpu_uint8')
    const body = crashedRunBody(loadPartial(storage), previousCrash(storage), { ios: 'fallback' })
    expect(body).toEqual({
      timings: { session_wasm_first_ms: 900, session_wasm_median_ms: 700, embed_wasm_first_ms: 410.3, embed_wasm_median_ms: 399.9 },
      device: { ios: '26.6', ios_raw: '18.7', gpu: true, crashedBefore: true },
      crashed_step: 'card_webgpu_uint8',
      client_id: partial.runId,
    })
    expect(Object.keys(body)).not.toContain('answer')
    expect(JSON.stringify(body)).not.toMatch(/photo|image/i)
  })

  it('gives every run an id that its partial and crash posts carry, so the server can store it once', () => {
    const partial = newPartial({})
    expect(partial.runId).toMatch(/^run-[a-z0-9]+-[a-z0-9]{8,16}$/)
    expect(newPartial({}).runId).not.toBe(partial.runId)
    expect(crashedRunBody(partial, 'search_art', {}).client_id).toBe(partial.runId)
    expect(crashedRunBody(null, 'search_art', {})).not.toHaveProperty('client_id')
  })

  it('posts a crash with no finished step too, using the device read after the reload', () => {
    const body = crashedRunBody(null, 'session_wasm', { ios: '26.6' })
    expect(body).toEqual({ timings: {}, device: { ios: '26.6', crashedBefore: true }, crashed_step: 'session_wasm' })
    expect(crashedRunBody(null, '', {}).crashed_step).toBe('unknown')
  })

  it('posts a crashed run on the next load, once, and keeps it when the post fails', async () => {
    const storage = new MemoryStorage()
    const posts = []
    expect(await reportPreviousCrash(async body => posts.push(body), {}, storage)).toBeNull() // a clean start posts nothing
    const partial = newPartial({ ios: '26.6' })
    recordStep(partial, 'embed_wasm', { first: 5, median: 4 }, storage)
    markStep('card_webgpu_uint8', storage)
    await expect(reportPreviousCrash(async () => { throw new Error('offline') }, {}, storage)).rejects.toThrow('offline')
    expect(previousCrash(storage)).toBe('card_webgpu_uint8') // kept for the next try
    expect(await reportPreviousCrash(async body => posts.push(body), {}, storage)).toBe('card_webgpu_uint8')
    expect(posts).toHaveLength(1)
    expect(posts[0].crashed_step).toBe('card_webgpu_uint8')
    expect(posts[0].timings.embed_wasm_median_ms).toBe(4)
    expect(await reportPreviousCrash(async body => posts.push(body), {}, storage)).toBeNull() // cleared: not posted twice
    recordStep(newPartial({}), 'a', { first: 1, median: 1 }, storage) // a partial run without a flag: the page was closed mid-run
    expect(await reportPreviousCrash(async body => posts.push(body), {}, storage)).toBe('page_closed')
  })

  it('clears the flag and the partial run once posted, and survives blocked storage', () => {
    const storage = new MemoryStorage()
    markStep('x', storage)
    recordStep(newPartial({}), 'a', { first: 1, median: 1 }, storage)
    markStep(null, storage)
    clearPartial(storage)
    expect(previousCrash(storage)).toBeNull()
    expect(loadPartial(storage)).toBeNull()
    const blocked = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, removeItem() { throw new Error('blocked') } }
    expect(() => { markStep('x', blocked); recordStep(newPartial({}), 'a', { first: 1, median: 1 }, blocked); clearPartial(blocked) }).not.toThrow()
    expect(previousCrash(blocked)).toBeNull()
    expect(timingsOf({ a: { error: 'no' }, b: { first: 2.26, median: 2.24 } })).toEqual({ a_first_ms: null, a_median_ms: null, b_first_ms: 2.3, b_median_ms: 2.2 })
  })
})
