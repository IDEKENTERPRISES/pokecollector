// The pure parts of the speed test that must survive a crashed page: the device facts, the order of the steps, the crash
// flag and the partial results saved after every step. No ORT, no DOM: unit-tested in Node.

export const ORT_VERSION = '1.31.1'
export const CRASH_KEY = 'pcPhoneSpeedStep'
export const PARTIAL_KEY = 'pcPhoneSpeedPartial'

/**
 * The device facts from the user agent. Since iOS 26 Safari freezes the OS version in the user agent at 18.x ("iPhone OS 18_7")
 * and the `Version/` token carries the real one, so from Safari 26 on the Safari version IS the iOS version.
 * `ios_raw` keeps what the user agent says.
 */
export function parseDevice(nav = globalThis.navigator, win = globalThis) {
  const ua = String(nav?.userAgent || '')
  const os = /OS (\d+)[._](\d+)(?:[._](\d+))?/.exec(ua)
  const safari = /Version\/(\d+(?:\.\d+)*)/.exec(ua)
  const raw = os ? `${os[1]}.${os[2]}` : null
  const safariVersion = safari ? safari[1] : null
  const frozen = Boolean(safariVersion && Number.parseInt(safariVersion, 10) >= 26 && raw)
  return {
    ua: ua.slice(0, 190),
    ios: frozen ? safariVersion : raw,
    ios_raw: raw,
    safari: safariVersion,
    gpu: Boolean(nav?.gpu),
    crossOriginIsolated: Boolean(win?.crossOriginIsolated),
    hardwareConcurrency: Number(nav?.hardwareConcurrency) || null,
    ortVersion: ORT_VERSION,
  }
}

/** "iOS 26.6 (user agent says 18.7)" or "iOS 18.2"; "iOS ?" when unknown. */
export function describeIos(device) {
  if (!device?.ios) return 'iOS ?'
  const note = device.ios_raw && device.ios_raw !== device.ios ? ` (user agent says ${device.ios_raw})` : ''
  return `iOS ${device.ios}${note}`
}

/**
 * The phases of a run, in the order they run. Everything on WebAssembly comes first (the photo, preprocessing, the model, the
 * index search and OCR), then WebGPU fp16, and the 8-bit model on WebGPU only when the switch is on, as the very last step:
 * it crashed an iPhone page, and a WebGPU crash must not cost the WebAssembly numbers.
 */
export function phaseOrder({ webgpu = true, uint8Gpu = false } = {}) {
  return ['photo', 'preprocess', 'wasm', 'index', 'ocr', ...(webgpu ? ['webgpu_fp16'] : []), ...(webgpu && uint8Gpu ? ['webgpu_uint8'] : [])]
}

// -- the crash flag and the partial results (sessionStorage, injectable for tests) -----------------------------------

const defaultStorage = () => { try { return globalThis.sessionStorage } catch { return null } }

export function previousCrash(storage = defaultStorage()) {
  try { return storage?.getItem(CRASH_KEY) || null } catch { return null }
}

export function markStep(name, storage = defaultStorage()) {
  try { if (name) storage?.setItem(CRASH_KEY, name); else storage?.removeItem(CRASH_KEY) } catch { /* storage blocked */ }
}

/** Timings as the server takes them, from the step rows so far ({first, median} or {error}). */
export function timingsOf(rows) {
  const timings = {}
  for (const [id, row] of Object.entries(rows || {})) {
    const round = value => (value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value * 10) / 10)
    timings[`${id}_first_ms`] = row.error ? null : round(row.first)
    timings[`${id}_median_ms`] = row.error ? null : round(row.median)
  }
  return timings
}

/** Save what exists after each finished step. Small: numbers and short texts only. */
export function savePartial(partial, storage = defaultStorage()) {
  try { storage?.setItem(PARTIAL_KEY, JSON.stringify(partial)) } catch { /* storage full or blocked: the run goes on */ }
}

export function loadPartial(storage = defaultStorage()) {
  try {
    const parsed = JSON.parse(storage?.getItem(PARTIAL_KEY) || 'null')
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

export function clearPartial(storage = defaultStorage()) {
  try { storage?.removeItem(PARTIAL_KEY) } catch { /* nothing to do */ }
}

/**
 * The run to post when the page comes back after a crash (or a run that ended early): the steps that finished, the device
 * facts and `crashed_step`. No photo, no phone answer. `device` is read again after the reload when the partial run has none.
 */
export function crashedRunBody(partial, crashedStep, device) {
  const timings = timingsOf(partial?.rows)
  return {
    timings,
    device: { ...(partial?.device || device || {}), crashedBefore: true },
    crashed_step: String(crashedStep || 'unknown').slice(0, 48),
  }
}

/** The stored copy of a run as the page keeps it while it runs: rows (first/median/error), device facts. */
export function newPartial(device) {
  return { startedAt: Date.now(), device, rows: {} }
}

/** Record one finished step into the partial run and save it at once. */
export function recordStep(partial, id, row, storage = defaultStorage()) {
  partial.rows[id] = row.error ? { error: String(row.error).slice(0, 120) } : { first: row.first, median: row.median }
  savePartial(partial, storage)
}

/**
 * On page load: if the last run died (a crash flag, or a saved partial run that was never finished), post it as a run with
 * `crashed_step` through `post(body)`, then clear the flag and the partial run. Returns the crashed step, or null when
 * there was nothing to report. A failed post keeps both for the next load.
 */
export async function reportPreviousCrash(post, device, storage = defaultStorage()) {
  const step = previousCrash(storage)
  const partial = loadPartial(storage)
  if (!step && !partial) return null
  const crashedStep = step || 'page_closed'
  await post(crashedRunBody(partial, crashedStep, device))
  markStep(null, storage)
  clearPartial(storage)
  return crashedStep
}
