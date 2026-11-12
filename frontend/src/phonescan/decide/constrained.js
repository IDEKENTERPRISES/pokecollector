// Port of backend/services/card_match/constrained.py: read the printed number against the closest printings
// ("which of these 20 cards is this text a damaged copy of"). Pure.

import { zfill } from './pyCompat.js'

const LOOKALIKE = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', '|': '/', '\\': '/', S: '5', B: '8', Z: '2' }
const SLASH_MISREADS = ['/', '1', '7', '']
export const MISREAD_PENALTY = 0.5

const digitsOf = value => String(value ?? '').replace(/\D/gu, '')
const stripZeros = value => value.replace(/^0+/, '')

function prepare(lines) {
  return lines
    .map(line => Array.from(String(line)).map(ch => LOOKALIKE[ch] ?? ch).join('').replace(/[^0-9/]/gu, ' '))
    .join(' ')
}

/** Fewest edits to turn some substring of ``text`` into ``pattern`` (Sellers), or null above ``limit``. */
function bestSubstringDistance(pattern, text, limit) {
  if (!pattern) return null
  const wanted = Array.from(pattern)
  let previous = Array.from({ length: wanted.length + 1 }, (_, index) => index)
  let best = previous[previous.length - 1]
  for (const char of Array.from(text)) {
    const current = [0]
    for (let j = 1; j <= wanted.length; j += 1) {
      current.push(Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (char === wanted[j - 1] ? 0 : 1)))
    }
    previous = current
    best = Math.min(best, previous[previous.length - 1])
  }
  return best <= limit ? best : null
}

function allowedEdits(number, total) {
  const size = number.length + total.length
  if (size >= 6) return 2
  if (size >= 4) return 1
  return 0
}

function forms(value) {
  const stripped = stripZeros(value) || '0'
  return [...new Set([stripped, zfill(stripped, 3)])]
}

/** How far ``text`` is from this printing's "number/total"; null when it is not close enough. */
export function patternDistance(number, total, text) {
  const n = digitsOf(number)
  const t = digitsOf(total)
  if (!n || !t) return null
  const limit = allowedEdits(stripZeros(n) || '0', stripZeros(t) || '0')
  let best = null
  for (const numberForm of forms(n)) {
    for (const totalForm of forms(t)) {
      for (const sep of SLASH_MISREADS) {
        const distance = bestSubstringDistance(`${numberForm}${sep}${totalForm}`, text, limit + 1)
        if (distance === null) continue
        const score = distance + (sep === '/' ? 0 : MISREAD_PENALTY)
        if (score <= limit && (best === null || score < best)) best = score
      }
    }
  }
  return best
}

/** The one candidate whose number/total the recognised text is a damaged copy of, or null. */
export function constrain(lines, candidates) {
  const text = prepare(lines)
  if (!/\d/.test(text)) return null
  const scored = []
  candidates.forEach((candidate, position) => {
    const number = candidate.number
    const total = candidate.printed_total
    if (!/^\d+$/.test(String(number || '')) || !digitsOf(total)) return
    const distance = patternDistance(number, total, text)
    if (distance !== null) scored.push({ distance, position, number: String(number), total: String(total) })
  })
  if (!scored.length) return null
  scored.sort((a, b) => a.distance - b.distance || a.position - b.position)
  const best = scored[0]
  const bestKey = [stripZeros(digitsOf(best.number)), stripZeros(digitsOf(best.total))]
  const others = scored.slice(1).filter(item => stripZeros(digitsOf(item.number)) !== bestKey[0] || stripZeros(digitsOf(item.total)) !== bestKey[1])
  if (scored.length - 1 !== others.length) return null // a printing with the same number and total: one answer as far as the text goes
  const runnerUp = others.length ? others[0].distance : null
  if (runnerUp !== null && runnerUp <= best.distance + MISREAD_PENALTY) return null
  return { index: best.position, number: best.number, total: best.total, distance: best.distance, runner_up: runnerUp }
}
