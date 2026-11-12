// The "Full phone matcher" mode of the speed test: the pure parts. Three runs of the whole matcher on one photo (the first run, and the
// median of the next two), the numbers it posts and the line the pages show. No DOM, no worker: the page passes the client in.
import { median, round } from './stats'

export const MATCHER_RUNS = 3
export const STAGE_ROWS = [
  ['finder', 'Find the card'], ['views', 'Build the views'], ['embed', 'Embeddings'], ['search', 'Picture search'],
  ['ocr_number', 'Read the number'], ['name', 'Read the name'], ['second_read', 'Second read of the whole picture'], ['decide', 'Decide'], ['total', 'Total per card'],
]

/** One stage's first run and the median of the runs after it ({first, median}); with one run only, the median is that run. */
export function stageTimes(results, stage) {
  const values = results.map(result => result.timings_ms?.[stage]).filter(value => Number.isFinite(value))
  if (!values.length) return { first: null, median: null }
  const rest = values.slice(1)
  return { first: round(values[0]), median: round(rest.length ? median(rest) : values[0]) }
}

export const summariseTimings = results => Object.fromEntries(STAGE_ROWS.map(([stage]) => [stage, stageTimes(results, stage)]))

/** The stage timings as the flat numbers the server stores (`matcher_<stage>_first_ms`, `matcher_<stage>_median_ms`). */
export function flatTimings(summary) {
  const out = {}
  for (const [stage, { first, median: mid }] of Object.entries(summary)) {
    out[`matcher_${stage}_first_ms`] = first
    out[`matcher_${stage}_median_ms`] = mid
  }
  return out
}

const trim = (value, length = 60) => (value === null || value === undefined ? null : String(value).slice(0, length))

/** Per stage, the number of reader model calls and their time: {ocr_number: {det_calls, det_ms, rec_calls, rec_ms}}. */
export function ocrCounts(stats) {
  const calls = stats?.calls
  if (!calls) return null
  const out = {}
  for (const [stage, entry] of Object.entries(calls)) {
    if (!['ocr_number', 'name', 'second_read'].includes(stage)) continue
    out[stage] = { det_calls: entry.det.n, det_ms: round(entry.det.ms), rec_calls: entry.rec.n, rec_ms: round(entry.rec.ms) }
  }
  return out
}

/** How the number ladder went: why it stopped, how many steps, the seconds against the budget. */
export function ladderOf(stats) {
  const number = stats?.number
  if (!number) return null
  return { stopped: trim(number.stopped, 12), attempts: number.attempts ?? null, seconds: number.seconds ?? null, budget: number.budget ?? null }
}

/** The settings of a run as one short text, e.g. "restart=1 overlap=0 ocr=wasm ladder=server runs=3". */
export function variantText({ restart, overlap, ocrBackend, ladder, runs, lowMemory = false }) {
  return `restart=${restart ? 1 : 0} overlap=${overlap ? 1 : 0} ocr=${ocrBackend === 'webgpu-main' ? 'gpu' : 'wasm'} ladder=${ladder} runs=${runs}${lowMemory ? ' low=1' : ''}`
}

/** A rough list of what is held in memory while the matcher is loaded, in MB (the bundle's sizes: iOS gives no memory reading). */
export function estimateMemory({ manifest, info, photo = null }) {
  const mb = bytes => Math.round(bytes / 1048576 * 10) / 10
  const size = path => (manifest?.files || []).find(file => file.path === path)?.size || 0
  const indexBytes = (manifest?.files || []).filter(file => file.path.startsWith('index/')).reduce((sum, file) => sum + file.size, 0)
  const rows = [['Picture indexes (whole + artwork, 8-bit)', mb(indexBytes)]]
  const embedModel = info?.backend?.startsWith('fp16') ? manifest?.model?.webgpu_candidate?.file : manifest?.model?.file
  rows.push([`Embedding model (${info?.backend ?? '?'})`, mb(size(embedModel))])
  rows.push(['Reader models (detection + recognition)', mb(size('ocr/det.onnx') + size('ocr/rec.onnx'))])
  rows.push(['Card database search indexes (about)', 16])
  if (photo) rows.push(['The photo as pixels (here, plus one copy per run in the worker)', mb(photo.width * photo.height * 4)])
  return { rows, total: Math.round(rows.reduce((sum, [, value]) => sum + value, 0) * 10) / 10 }
}

/**
 * The `matcher` block of a posted run, from the results (the first one's answer is the answer: the runs are the same photo, so the
 * answers agree unless something is nondeterministic, which `stable` says).
 */
export function matcherBlock(results, { photo = null, info = null, variant = null } = {}) {
  const first = results[0]
  const summary = summariseTimings(results)
  const key = result => `${result.tcgCardId ?? 'unsure'}|${result.mechanism ?? ''}`
  return {
    version: first.version,
    backend: trim(first.backend, 80),
    mode: trim(info?.mode, 24),
    runs: results.length,
    variant: trim(variant, 120),
    ocr: ocrCounts(first.ocrStats),
    ladder: ladderOf(first.ocrStats),
    stable: results.every(result => key(result) === key(first)),
    decided: Boolean(first.decided),
    card: first.decided ? trim(first.tcgCardId, 64) : null,
    mechanism: trim(first.mechanism, 40),
    reason: trim(first.unsure_reason, 80),
    similarity: first.decision ? round(first.decision.similarity, 4) : null,
    picture_only: Boolean(first.pictureOnly),
    top20: (first.matches || []).slice(0, 20).map(match => [trim(match.tcg_card_id, 64), round(match.similarity, 4)]),
    read: first.read ? { number: trim(first.read.number, 16), total: trim(first.read.total, 16), name: trim(first.read.name, 40), source: trim(first.read.numberSource, 20) } : null,
    orientation: first.orientation ? { by: trim(first.orientation.by, 12), flipped: Boolean(first.orientation.flipped) } : null,
    detection: first.detection ? { source: trim(first.detection.source, 12), found: Boolean(first.detection.found) } : null,
    wholeread: first.wholeread ? { tried: Boolean(first.wholeread.tried), rescued: Boolean(first.wholeread.rescued) } : null,
    catalogue: first.catalogue ? { present: Boolean(first.catalogue.present), cards: first.catalogue.cards ?? null } : null,
    photo: photo ? { width: photo.width, height: photo.height, bytes: photo.bytes ?? null } : null,
    timings: Object.fromEntries(Object.entries(summary).map(([stage, value]) => [stage, [value.first, value.median]])),
  }
}

/**
 * Runs the matcher `runs` times on the photo: `copy()` gives a fresh {data, width, height} each time (the worker takes the buffer).
 * `onRun(n, result)` after each. Returns the results in order.
 */
export async function runMatcherRuns({ client, copy, runs = MATCHER_RUNS, onStage = null, onRun = null, useText = true, overlap = false, beforeRun = null }) {
  const results = []
  for (let n = 1; n <= runs; n++) {
    await beforeRun?.(n) // e.g. restart the worker so every run starts from a fresh heap
    const result = await client.match(copy(), { onStage: (stage, info) => onStage?.(stage, n, info), useText, overlap })
    results.push(result)
    onRun?.(n, result)
  }
  return results
}

/** The speed-test run body for a matcher run: flat stage timings + device + the `matcher` block. */
export function matcherOutcome({ results, device, runId, photo, info, variant = null }) {
  const block = matcherBlock(results, { photo, info, variant })
  const summary = summariseTimings(results)
  return { timings: flatTimings(summary), device, matcher: block, runId, summary }
}

/** One line for a result: the card and how it was decided, or "unsure (reason)". */
export function describeDecision(result) {
  if (!result) return '–'
  if (result.pictureOnly) return 'picture only (no card database): no decision'
  if (result.decided) {
    const top = (result.candidates || []).find(candidate => candidate.id === result.cardId)
    return `${top?.name ?? result.tcgCardId}${top?.number ? ` #${top.number}` : ''} · ${result.mechanism}`
  }
  return `unsure (${result.unsure_reason})`
}
