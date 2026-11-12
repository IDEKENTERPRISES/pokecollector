// The identifier rules of backend/api/recognize.py that the picture matcher reuses: number and printed-total
// normalising, name keys and compatibility, the candidate ranking key and the metadata decision.
// Pure functions over plain objects. Ported line by line; the differences from the server are listed in
// docs/phone-scanner/decide.md ("What is not ported").

import { compareTuples, stripDiacritics } from './pyCompat.js'

const GALLERY_PREFIXES = ['tg', 'gg', 'sv', 'rc']

// ── numbers ──────────────────────────────────────────────────────────────────

/** recognize._normalize_collector_number: "TG06/TG30" -> "tg6", "018" -> "18", "9a" -> "9a"; null when it is not a number. */
export function normalizeNumber(value) {
  if (value === null || value === undefined) return null
  const local = String(value).split('/')[0].trim()
  const compact = local.replace(/[\s_-]+/g, '')
  const match = /^([A-Za-z]*)(\d+)([A-Za-z]*)$/.exec(compact)
  if (!match) return null
  const [, prefix, digits, suffix] = match
  return `${prefix.toLowerCase()}${digits.replace(/^0+(?=\d)/, '')}${suffix.toLowerCase()}`
}

export function numbersMatch(left, right) {
  const normalizedLeft = normalizeNumber(left)
  const normalizedRight = normalizeNumber(right)
  return normalizedLeft !== null && normalizedLeft === normalizedRight
}

/** A printed set total; the known gallery prefixes (TG, GG, SV, RC) are dropped, an unknown one makes it unusable. */
export function normalizePrintedTotal(value) {
  const normalized = normalizeNumber(value)
  if (!normalized) return null
  const prefixed = /^([a-z]+)(\d+)$/.exec(normalized)
  if (!prefixed) return normalized
  return GALLERY_PREFIXES.includes(prefixed[1]) ? prefixed[2] : null
}

/** 0 agreement, 1 unknown, 2 contradiction. */
export function printedTotalSignal(recognizedTotal, candidateTotal) {
  const normalized = normalizePrintedTotal(recognizedTotal)
  const candidateNormalized = normalizePrintedTotal(candidateTotal)
  if (normalized === null || candidateNormalized === null) return 1
  return normalized === candidateNormalized ? 0 : 2
}

// ── names ────────────────────────────────────────────────────────────────────

const TRAILING_QUALIFIER = /\s*\(([^()]*)\)\s*$/
const SEPARATORS = /[\s\-‐-―'‘’ʼ`´.]+/gu
const SUFFIXES = /[\s-]+(?:EX|ex|GX|gx|V|VMAX|VSTAR|VStar|TAG\s*TEAM|BREAK|LV\.?\s*X)\s*$/i

export function simplifyName(name) {
  return String(name).replace(SUFFIXES, '').trim()
}

export function normalizedScannerName(name) {
  const value = String(name || '').trim()
  return stripDiacritics(value).replace(/\s+/gu, ' ').trim()
}

export function nameSearchKey(name) {
  const text = String(name || '')
  const base = text.replace(TRAILING_QUALIFIER, '').trim() || text.trim()
  return base.replace(SEPARATORS, '')
}

export function scannerNamesCompatible(expected, candidate) {
  const expectedName = normalizedScannerName(expected)
  const candidateName = normalizedScannerName(candidate)
  if (!expectedName || !candidateName) return false
  if (expectedName === candidateName) return true
  const expectedQualifier = TRAILING_QUALIFIER.exec(expectedName)
  const candidateQualifier = TRAILING_QUALIFIER.exec(candidateName)
  const expectedBase = expectedQualifier ? expectedName.slice(0, expectedQualifier.index).trim() : expectedName
  const candidateBase = candidateQualifier ? candidateName.slice(0, candidateQualifier.index).trim() : candidateName
  if (expectedBase.replace(SEPARATORS, '') !== candidateBase.replace(SEPARATORS, '')) return false
  if (!expectedQualifier || !candidateQualifier) return true
  return expectedQualifier[1].replace(SEPARATORS, '') === candidateQualifier[1].replace(SEPARATORS, '')
}

// ── ranking and the metadata decision ───────────────────────────────────────

const ARTIST_PREFIX = /^\s*(?:illus|illustrator|art|artwork)(?:\s*[.:]\s*|\s+by\s+|\s+)/i

function normalizeArtist(value) {
  if (!value) return null
  const stripped = String(value).replace(ARTIST_PREFIX, '')
  const collapsed = stripped.split(/\s+/).filter(Boolean).join(' ').trim().toLowerCase()
  return collapsed || null
}

function artistsMatch(left, right) {
  const a = normalizeArtist(left)
  const b = normalizeArtist(right)
  return a !== null && a === b
}

function isEmpty(value) {
  return value === null || value === undefined || value === ''
}

/** 0 agreement, 1 unknown, 2 contradiction. */
function identitySignal(target, candidate, matcher) {
  if (isEmpty(target) || isEmpty(candidate)) return 1
  return matcher(target, candidate) ? 0 : 2
}

function lowerKey(value) {
  const text = String(value || '').trim().toLowerCase()
  return text || null
}

// The language is never evidence on the phone either (English catalogue; the server sets card_info.language to None).
export function candidateRankKey(cardInfo, candidate) {
  return [
    identitySignal(cardInfo.number_local, candidate.number, numbersMatch),
    1, // language: card_info.language is always None, so "unknown"
    printedTotalSignal(cardInfo.number_total, candidate.printed_total),
    identitySignal(lowerKey(cardInfo.set_code), lowerKey(candidate.set_abbreviation), (l, r) => l === r),
    identitySignal(lowerKey(cardInfo.regulation_mark), lowerKey(candidate.regulation_mark), (l, r) => l === r),
    identitySignal(cardInfo.artist, candidate.artist, artistsMatch),
    identitySignal(cardInfo.hp, candidate.hp, numbersMatch),
  ]
}

const SIGNAL_NAMES = ['number', 'language', 'total', 'set', 'regulation', 'artist', 'hp']

function sameKey(left, right) {
  return compareTuples(left, right) === 0
}

/** Decide only when reliable metadata isolates one candidate: [decided, mechanism]. */
export function metadataDecision(cardInfo, candidates) {
  if (!candidates.length) return [false, null]
  const keyed = candidates.map(card => ({ card, key: candidateRankKey(cardInfo, card) }))
  keyed.sort((a, b) => compareTuples(a.key, b.key))
  const top = keyed[0]
  if (keyed.filter(item => sameKey(item.key, top.key)).length !== 1) return [false, null]
  if (top.key.includes(2)) return [false, null]
  const signals = new Set(SIGNAL_NAMES.filter((name, index) => top.key[index] === 0))
  if (keyed.some(item => item.card._gallery_alternative)) signals.delete('number')
  const numberMatches = keyed.filter(item => identitySignal(cardInfo.number_local, item.card.number, numbersMatch) === 0).length
  if (signals.has('number') && numberMatches === 1) return [true, 'number_unique']
  if (signals.has('number') && ['language', 'total', 'set', 'regulation'].some(name => signals.has(name))) return [true, 'number_metadata']
  if (!cardInfo.number_local && signals.has('artist') && signals.has('hp')) return [true, 'artist_hp']
  // The server's last branch (``sole_candidate``: a Trainer or Energy found by native language and name) needs
  // card_info.language and card_info.card_type, which the picture matcher never sets, so it can never fire here.
  return [false, null]
}
