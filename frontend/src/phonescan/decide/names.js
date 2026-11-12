// Port of the catalogue side of backend/services/card_match/names.py: name keys, the similarity and the
// NameIndex fuzzy name search. (Reading the name line off the picture, ``parse_name_lines``, belongs to the
// text reader, folder phonescan/ocr.) Pure; the index is plain data.

import { SequenceMatcher } from './difflib.js'
import { numbersMatch, nameSearchKey, normalizedScannerName, normalizePrintedTotal, scannerNamesCompatible, simplifyName } from './rules.js'
import { pyRound } from './pyCompat.js'

export const NAME_MIN_SCORE = 0.72
export const NAME_CLOSE_BAND = 0.12
export const MAX_NAMES = 8
export const MAX_TEXT_CANDIDATES = 200

/** The Ollama path's own key, lower-cased: case, accents, separators and a trailing "(Giovanni)" qualifier do not matter. */
export function nameKey(name) {
  return nameSearchKey(normalizedScannerName(name)).toLowerCase()
}

/** The key without a trailing card-type suffix (ex, V, GX ...), so "Charizrd" still finds "Charizard ex". */
export function baseKey(name) {
  return nameKey(simplifyName(normalizedScannerName(name)))
}

/** ``other`` against the matcher's seq2 (set once; seq1 changes per call). */
function ratioAgainst(matcher, other) {
  if (!other) return 0.0
  matcher.setSeq1(other)
  if (matcher.realQuickRatio() < 0.6 || matcher.quickRatio() < 0.6) return 0.0
  return matcher.ratio()
}

function similar(left, right) {
  if (!left || !right) return 0.0
  if (left === right) return 1.0
  const matcher = new SequenceMatcher(left, right)
  if (matcher.realQuickRatio() < 0.6 || matcher.quickRatio() < 0.6) return 0.0
  return matcher.ratio()
}

/**
 * ``rows``: {card_id, name, number, printed_total}. Returns the plain-data index:
 * {rows: Map id -> {card_id, name, number, printed_total, key, base_key}, byKey: Map key -> [ids]}.
 */
export function buildNameIndex(rows) {
  const index = { rows: new Map(), byKey: new Map() }
  for (const row of rows) {
    const key = row.key || nameKey(row.name)
    const entry = { card_id: row.card_id, name: row.name, number: row.number ?? null, printed_total: row.printed_total ?? null, key, base_key: row.base_key || baseKey(row.name) }
    index.rows.set(row.card_id, entry)
    if (!index.byKey.has(key)) index.byKey.set(key, [])
    index.byKey.get(key).push(row.card_id)
  }
  return index
}

/** (score, name key) of the catalogue names close to the read name, best first. */
export function scoreNames(index, readName) {
  const readKey = nameKey(readName)
  const readBase = baseKey(readName)
  if (!readKey) return []
  const full = new SequenceMatcher('', readKey)
  const base = new SequenceMatcher('', readBase || readKey)
  const readKeyLength = Array.from(readKey).length
  const readBaseLength = Array.from(readBase).length
  const scored = []
  for (const [key, ids] of index.byKey) {
    if (key === readKey) {
      scored.push([1.0, key])
      continue
    }
    const keyLength = Array.from(key).length
    const baseOf = index.rows.get(ids[0]).base_key
    if (Math.abs(keyLength - readKeyLength) > 0.5 * Math.max(keyLength, readKeyLength)
        && Math.abs(Array.from(baseOf).length - readBaseLength) > 0.5 * Math.max(readBaseLength, 1)) continue
    const score = Math.max(ratioAgainst(full, key), 0.97 * ratioAgainst(base, baseOf))
    if (score >= NAME_MIN_SCORE) scored.push([score, key])
  }
  scored.sort((a, b) => b[0] - a[0])
  return scored
}

/** How a catalogue card agrees with the number and total read at the bottom. */
export function agreement(index, cardId, nameScore, number, total) {
  const row = index.rows.get(cardId)
  // (the server would raise for a card with no catalogue row; on the phone a picture-index id the catalogue lacks is "unknown")
  if (!row) return { card_id: cardId, name_score: nameScore, number_ok: number ? false : null, total_ok: null }
  const numberOk = number ? numbersMatch(number, row.number) : null
  let totalOk = null
  if (total && row.printed_total) {
    const read = normalizePrintedTotal(total)
    const printed = normalizePrintedTotal(row.printed_total)
    totalOk = read !== null && read === printed
  }
  return { card_id: cardId, name_score: nameScore, number_ok: numberOk, total_ok: totalOk }
}

/** Printings of the catalogue names close to ``readName``, best name first; the ones carrying the read number come first. */
export function searchNames(index, readName, number = null, total = null, { limit = MAX_TEXT_CANDIDATES } = {}) {
  if (!readName) return []
  const scored = scoreNames(index, readName)
  if (!scored.length) return []
  const floor = scored[0][0] - NAME_CLOSE_BAND
  let hits = []
  for (const [score, key] of scored.slice(0, MAX_NAMES)) {
    if (score < floor) break
    for (const cardId of index.byKey.get(key)) hits.push(agreement(index, cardId, score, number, total))
  }
  // sort key: (-name_score, number_ok is not True, total_ok is False), stable
  hits = hits
    .map((hit, position) => ({ hit, position }))
    .sort((a, b) => (b.hit.name_score - a.hit.name_score)
      || (Number(a.hit.number_ok !== true) - Number(b.hit.number_ok !== true))
      || (Number(a.hit.total_ok === false) - Number(b.hit.total_ok === false))
      || (a.position - b.position))
    .map(item => item.hit)
  if (number) {
    const withNumber = hits.filter(hit => hit.number_ok)
    if (withNumber.length) hits = [...withNumber, ...hits.filter(hit => !hit.number_ok)]
  }
  return hits.slice(0, limit)
}

/** How well one card's name matches the read name (0 when nothing was read). */
export function nameScoreOf(index, cardId, readName) {
  const row = index.rows.get(cardId)
  if (!row || !readName) return 0.0
  if (scannerNamesCompatible(readName, row.name)) return 1.0
  const score = Math.max(similar(nameKey(readName), row.key), 0.97 * similar(baseKey(readName), row.base_key))
  return score >= NAME_MIN_SCORE ? score : 0.0
}

export const roundScore = (value, digits = 3) => pyRound(value, digits)
