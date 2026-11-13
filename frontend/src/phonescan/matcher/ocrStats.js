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

/** The ladder steps as the page and the server comparison show them: label, ms, how many text lines it found, what they said, and the number (or name) held after it. */
export function stepsOf(strips) {
  return (strips || []).filter(strip => strip.label !== 'hp').map(strip => {
    const lines = (strip.lines || []).map(line => String(line.text ?? ''))
    const after = strip.after
    let held = null
    if (after && 'number' in after) held = `${after.number || '-'}/${after.total || '-'}`
    else if (after && 'name' in after) held = after.name || null
    return { label: String(strip.label ?? '').slice(0, 24), variant: strip.variant ?? null, zoom: strip.zoom ?? null, ms: strip.ms ?? null, lines: lines.length, text: lines.join(' | ').slice(0, 70), after: held ? String(held).slice(0, 40) : null, source: strip.source ?? null }
  })
}

/** One reading's ladder as the page shows it: why it stopped, the budget and the seconds used, and the steps that ran (`steps` = every step of the final reading, second read included). */
export function ladderSummary(reading, budget, final = reading) {
  if (!reading) return null
  return { budget, seconds: reading.seconds ?? null, attempts: reading.attempts ?? null, stopped: reading.stopped ?? null, steps: stepsOf((final || reading).strips) }
}
