// What the text reader cost, call by call: wraps the reader's `{detect, recognise, characters}` sessions, times every model call and
// files it under the matcher stage that was running (`mark(stage)`). The matcher puts `take()` into its result as `ocrStats.calls`, so the page can show
// how many detection and recognition calls each stage made, how long each took and the input sizes.

export function recordSessions(inner, now = () => performance.now()) {
  let stage = 'ocr'
  let calls = {}
  const slot = () => (calls[stage] ||= { det: { n: 0, ms: 0, inputs: [] }, rec: { n: 0, ms: 0, inputs: [] } })
  const wrap = (kind, run) => async tensor => {
    const began = now()
    try {
      return await run(tensor)
    } finally {
      const entry = slot()[kind]
      entry.n += 1
      entry.ms += now() - began
      if (entry.inputs.length < 24) entry.inputs.push(Array.from(tensor.dims || []).join('x'))
    }
  }
  return {
    characters: inner.characters,
    detect: wrap('det', tensor => inner.detect(tensor)),
    recognise: wrap('rec', tensor => inner.recognise(tensor)),
    mark(name) { stage = name },
    /** The calls since the last `take()`, per stage: {det: {n, ms, perCall, inputs}, rec: {...}}. Resets the counters. */
    take() {
      const out = {}
      for (const [name, entry] of Object.entries(calls)) {
        out[name] = Object.fromEntries(['det', 'rec'].map(kind => [kind, {
          n: entry[kind].n, ms: Math.round(entry[kind].ms * 10) / 10, perCall: entry[kind].n ? Math.round(entry[kind].ms / entry[kind].n * 10) / 10 : null, inputs: entry[kind].inputs,
        }]))
      }
      calls = {}
      return out
    },
    release: () => inner.release?.(),
    inner,
  }
}

/** One reading's ladder as the page shows it: the steps that ran and why it stopped. */
export function ladderSummary(reading, budget) {
  if (!reading) return null
  return {
    budget, seconds: reading.seconds ?? null, attempts: reading.attempts ?? null, stopped: reading.stopped ?? null,
    steps: (reading.strips || []).filter(strip => strip.label !== 'hp').map(strip => ({ label: strip.label, variant: strip.variant, zoom: strip.zoom, ms: strip.ms, source: strip.source ?? null })),
  }
}
