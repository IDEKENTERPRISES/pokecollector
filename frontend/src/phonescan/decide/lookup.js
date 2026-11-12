// Port of backend/services/card_match/lookup.py: candidates from printed text other than the name
// (number / printed total / set code, and card body text). Pure; the index is plain data (Maps, Sets and
// arrays, structured-cloneable, so it can be built in a worker and handed to the main thread).

import { SequenceMatcher } from './difflib.js'
import { pyRound, splitWords, stripDiacritics, strOrEmpty } from './pyCompat.js'

export const EXTRA_SET_CODES = {
  SVP: ['svp'], PRSV: ['svp'], SWSH: ['swshp'], PRSW: ['swshp'], SMP: ['smp'], PRSM: ['smp'], XYP: ['xyp'], BWP: ['bwp'], MEP: ['mep'],
}

export const NUMBER_PREFIXES = new Set([
  'TG', 'GG', 'SV', 'RC', 'SWSH', 'SVP', 'SMP', 'SM', 'XYP', 'XY', 'BWP', 'BW', 'DP', 'HGSS', 'MEP', 'SH', 'PR', 'PRSV', 'PRSW', 'PRSM',
  'H', 'S', 'P', 'NP', 'RT',
])

export function isSetCodePrefix(letters) {
  const upper = String(letters || '').toUpperCase()
  return upper.length >= 3 && !NUMBER_PREFIXES.has(upper)
}

export const LEVEL_ORDER = ['number_total_set', 'number_total', 'number_set', 'number']
export const LEVEL_BONUS = { number_total_set: 0.20, number_total: 0.14, number_set: 0.10, number: 0.0 }
export const MAX_ADDED_PER_PAIR = 30
export const TEXT_WEIGHT = 0.15
export const RULE_WEIGHT = 0.04
export const TEXT_ADD_MAX_CARDS = 12
export const TEXT_MIN_COVERAGE = 0.80
export const TEXT_MIN_CHARS = 18
export const NAME_MIN_CHARS = 6
export const MAX_TEXT_LINES = 14

const PAIR = /(?<![0-9])([A-Za-z]{0,4}\s?\d{1,3})\s*[/\\]\s*([A-Za-z]{0,4}\s?\d{1,3})(?![0-9])/g
const PAIR_BAR = /(?<![0-9A-Za-z])(\d{1,3})\s*\|\s*(\d{2,3})(?![0-9])/g
const WORD_TOKEN = /[A-Za-z][A-Za-z0-9]{1,5}|[0-9]+[A-Za-z]+[A-Za-z0-9]*/g
const RULE = /\b(ex|gx|vmax|vstar|v)\s+rule\b|\bpok.?mon[\s-]+(ex|gx|v)\b.{0,40}\bknocked\s+out/gi
const PRIZE_RULE = /knocked\s+out.{0,30}(?:opponent|takes).{0,25}prize/i
const SUFFIXES = ['vstar', 'vmax', 'gx', 'ex', 'v']

export function numberKey(value) {
  const text = strOrEmpty(value).replace(/\s+/g, '').toUpperCase()
  const match = /^([A-Z]{0,5})0*(\d{1,3})([A-Z]?)$/.exec(text)
  return match ? `${match[1]}${match[2]}${match[3]}` : null
}

export function totalKey(value) {
  const text = strOrEmpty(value).replace(/\s+/g, '').toUpperCase()
  const match = /^(?:TG|GG|SV|RC)?0*(\d{1,4})$/.exec(text)
  return match ? match[1] : null
}

/** Lower case, accents and punctuation gone, single spaces: the comparable form of body text. */
export function normText(text) {
  const folded = stripDiacritics(String(text ?? ''))
  return folded.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

// ── reading the identifiers out of OCR lines ────────────────────────────────

/** Every "number/total" pair the recognised text holds, as [number key, total key or null]. */
export function numberPairs(lines, parsedNumber = null, parsedTotal = null) {
  const pairs = []
  const has = pair => pairs.some(item => item[0] === pair[0] && item[1] === pair[1])

  const add = (number, total) => {
    const key = numberKey(number)
    if (key === null) return
    const tKey = total ? totalKey(total) : null
    const letters = /^[A-Z]*/.exec(key)[0]
    if (isSetCodePrefix(letters)) {
      const bare = [key.slice(letters.length), tKey]
      if (!has(bare)) pairs.push(bare)
    }
    const pair = [key, tKey]
    if (!has(pair)) pairs.push(pair)
  }

  if (parsedNumber) add(parsedNumber, parsedTotal)
  for (const line of lines) {
    const text = strOrEmpty(line)
    if (text.startsWith('[hp]')) continue
    for (const match of text.matchAll(PAIR)) add(match[1], match[2])
    for (const match of text.matchAll(PAIR_BAR)) add(match[1], match[2])
  }
  return pairs
}

/** Upper-case words that could be a printed set code (they hold a letter). */
export function setCodeTokens(tokens, lines = []) {
  const out = []
  const all = [...tokens]
  for (const line of lines) all.push(...(strOrEmpty(line).toUpperCase().match(WORD_TOKEN) ?? []))
  for (const raw of all) {
    const token = String(raw).toUpperCase()
    if (/[A-Z]/.test(token) && token.length >= 2 && token.length <= 6 && !out.includes(token)) out.push(token)
    const glued = /^([A-Z]{2,5})\d{1,3}[A-Z]?$/.exec(token)
    if (glued && !out.includes(glued[1])) out.push(glued[1])
  }
  return out
}

// ── the catalogue side ───────────────────────────────────────────────────────

function sentences(text) {
  return strOrEmpty(text).split(/(?<=[.!?])\s+|\n+/).map(part => part.trim()).filter(Boolean)
}

/** [kind, text] for every searchable piece of a card: attack and ability names, effect sentences. */
export function cardTexts(cardEffect, attacks, abilities) {
  const out = []
  for (const sentence of sentences(cardEffect)) out.push(['effect', sentence])
  for (const group of [attacks, abilities]) {
    for (const item of Array.isArray(group) ? group : []) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue
      if (item.name) out.push(['name', String(item.name)])
      for (const sentence of sentences(item.effect)) out.push(['effect', sentence])
    }
  }
  return out
}

function suffixOf(name, suffix) {
  const source = suffix || name
  const tail = source ? normText(source).split(' ').at(-1) : ''
  return SUFFIXES.includes(tail) ? tail : null
}

/**
 * An incremental builder for the lookup index (so a caller can feed rows in chunks and yield between them).
 * ``setCodes``: upper-case printed code -> set ids (a plain object or a Map).
 */
export function createLookupBuilder(setCodes = {}) {
  const codes = new Map()
  const entries = setCodes instanceof Map ? [...setCodes.entries()] : Object.entries(setCodes)
  for (const [code, ids] of entries) codes.set(code.toUpperCase(), new Set(ids))
  for (const [code, ids] of Object.entries(EXTRA_SET_CODES)) {
    if (!codes.has(code)) codes.set(code, new Set())
    for (const id of ids) codes.get(code).add(id)
  }
  const index = {
    rows: new Map(),
    byNumber: new Map(),
    suffix: new Map(),
    segments: [],
    segmentCards: [],
    segmentKind: [],
    tokenSegments: new Map(),
    nameBuckets: new Map(),
    idf: new Map(),
    setCodes: new Map([...codes].map(([code, ids]) => [code, [...ids]])),
  }
  const seen = new Map()
  const cardSets = []
  const tokenSets = new Map()

  function add(row) {
    index.rows.set(row.card_id, { card_id: row.card_id, name: row.name, number: row.number ?? null, printed_total: row.printed_total ?? null, set_id: row.set_id ?? null })
    const key = numberKey(row.number)
    if (key) {
      if (!index.byNumber.has(key)) index.byNumber.set(key, [])
      index.byNumber.get(key).push(row.card_id)
    }
    index.suffix.set(row.card_id, suffixOf(row.name, row.suffix))
    for (const [kind, text] of row.texts ?? []) {
      const normal = normText(text)
      if (normal.length < (kind === 'name' ? NAME_MIN_CHARS : TEXT_MIN_CHARS)) continue
      const id = `${kind}\u0000${normal}`
      let segment = seen.get(id)
      if (segment === undefined) {
        segment = index.segments.length
        seen.set(id, segment)
        index.segments.push(normal)
        cardSets.push(new Set())
        index.segmentKind.push(kind)
        if (kind === 'name') {
          if (!index.nameBuckets.has(normal.length)) index.nameBuckets.set(normal.length, [])
          index.nameBuckets.get(normal.length).push(segment)
        } else {
          for (const token of new Set(normal.split(' '))) {
            if (token.length >= 4) {
              if (!tokenSets.has(token)) tokenSets.set(token, new Set())
              tokenSets.get(token).add(segment)
            }
          }
        }
      }
      cardSets[segment].add(row.card_id)
    }
  }

  function finish() {
    index.segmentCards = cardSets.map(set => [...set])
    const total = Math.max(1, index.segments.length)
    // Words on a fifth of all sentences carry no information ("your", "this", "card").
    for (const [token, ids] of tokenSets) {
      index.tokenSegments.set(token, [...ids])
      if (ids.size <= 0.2 * total) index.idf.set(token, Math.log(total / ids.size))
    }
    return index
  }

  return { add, finish }
}

/** The lookup index for a list of rows: {card_id, name, number, printed_total, set_id, suffix, texts: [[kind, text]]}. */
export function buildLookupIndex(rows, setCodes = {}) {
  const builder = createLookupBuilder(setCodes)
  for (const row of rows) builder.add(row)
  return builder.finish()
}

// ── number lane ──────────────────────────────────────────────────────────────

function setsForCodes(index, tokens) {
  const found = new Set()
  const used = []
  for (const token of tokens) {
    const upper = String(token).toUpperCase()
    const ids = index.setCodes.get(upper)
    if (ids) {
      for (const id of ids) found.add(id)
      used.push(upper)
    }
  }
  return [found, used]
}

/** Cards carrying a read number, at the strongest level each reaches. */
export function findNumbers(index, pairs, tokens = []) {
  const [setIds, usedCodes] = setsForCodes(index, tokens)
  const hits = new Map()
  const put = (cardId, level, pair) => {
    const old = hits.get(cardId)
    if (!old || LEVEL_ORDER.indexOf(level) < LEVEL_ORDER.indexOf(old.level)) hits.set(cardId, { card_id: cardId, level, pair })
  }
  for (const pair of pairs) {
    const [number, total] = pair
    const ids = index.byNumber.get(number) ?? []
    const strong = []
    for (const cardId of ids) {
      const row = index.rows.get(cardId)
      const inSet = setIds.size > 0 && setIds.has(row.set_id)
      const printed = totalKey(row.printed_total)
      const totalOk = Boolean(total) && printed !== null && printed === total
      if (totalOk && inSet) strong.push([cardId, 'number_total_set'])
      else if (totalOk) strong.push([cardId, 'number_total'])
      else if (inSet && !total) strong.push([cardId, 'number_set'])
      else put(cardId, 'number', pair)
    }
    if (strong.length > MAX_ADDED_PER_PAIR) {
      for (const [cardId] of strong) put(cardId, 'number', pair)
      continue
    }
    for (const [cardId, level] of strong) put(cardId, level, pair)
  }
  return [hits, usedCodes]
}

// ── card-text lane ───────────────────────────────────────────────────────────

function matchEffect(index, normal) {
  const tokens = new Set(normal.split(' ').filter(token => token.length >= 4 && index.idf.has(token)))
  if (tokens.size < 2) return []
  const votes = new Map()
  for (const token of tokens) {
    for (const segment of index.tokenSegments.get(token)) {
      if (index.segmentKind[segment] === 'effect') votes.set(segment, (votes.get(segment) ?? 0) + index.idf.get(token))
    }
  }
  const out = []
  const matcher = new SequenceMatcher('', normal)
  const best = [...votes.keys()].sort((a, b) => votes.get(b) - votes.get(a)).slice(0, 6)
  for (const segment of best) {
    const text = index.segments[segment]
    matcher.setSeq1(text)
    const shared = matcher.getMatchingBlocks().filter(block => block.size >= 3).reduce((sum, block) => sum + block.size, 0)
    const coverage = shared / Math.max(1, Math.min(Array.from(text).length, Array.from(normal).length))
    if (coverage >= TEXT_MIN_COVERAGE) out.push([coverage, segment, 'effect'])
  }
  return out
}

function matchName(index, normal) {
  if (normal.length < NAME_MIN_CHARS || splitWords(normal).length > 4) return []
  const out = []
  for (let length = normal.length - 2; length < normal.length + 3; length += 1) {
    for (const segment of index.nameBuckets.get(length) ?? []) {
      const text = index.segments[segment]
      if (text === normal) out.push([1.0, segment, 'name'])
      else if (text[0] === normal[0] && new SequenceMatcher(text, normal).ratio() >= 0.9) out.push([0.9, segment, 'name'])
    }
  }
  return out
}

/** [card id -> best text match, rule kinds named such as {"ex"}] for OCR'd body text. */
export function findText(index, lines) {
  const hits = new Map()
  const rules = new Set()
  const list = lines.map(line => strOrEmpty(line))
  const joined = list.filter(line => !line.startsWith('[hp]')).join(' ')
  for (const match of joined.matchAll(RULE)) {
    const kind = (match[1] || match[2] || '').toLowerCase()
    if (kind) rules.add(kind)
  }
  if (PRIZE_RULE.test(joined)) rules.add('ex')
  let used = 0
  for (const line of list) {
    if (line.startsWith('[hp]') || used >= MAX_TEXT_LINES) continue
    const normal = normText(line)
    if (normal.length < NAME_MIN_CHARS) continue
    used += 1
    const found = normal.length >= TEXT_MIN_CHARS ? matchEffect(index, normal) : []
    found.push(...matchName(index, normal.replace(/\b\d+\b/g, ' ').trim()))
    for (const [score, segment, via] of found) {
      const cards = index.segmentCards[segment]
      const spec = cards.length <= 6 ? 1.0 : 6.0 / cards.length
      for (const cardId of cards) {
        const value = score * spec
        const old = hits.get(cardId)
        if (!old) {
          hits.set(cardId, { score: value, cards: cards.length, via })
        } else { // a second agreeing line adds a little
          hits.set(cardId, { score: Math.min(1.0, Math.max(old.score, value) + 0.15 * Math.min(old.score, value)), cards: Math.min(old.cards, cards.length), via })
        }
      }
    }
  }
  return [hits, rules]
}

// ── both lanes ───────────────────────────────────────────────────────────────

export function emptyEvidence() {
  return { numbers: new Map(), text: new Map(), rule_kinds: new Set(), suffix_of: new Map(), set_codes: [], pairs: [] }
}

export function searchLookup(index, lines, parsedNumber, parsedTotal, tokens, { number = true, text = true } = {}) {
  const evidence = emptyEvidence()
  if (number) {
    evidence.pairs = numberPairs(lines, parsedNumber, parsedTotal)
    const candidates = setCodeTokens(tokens, lines)
    ;[evidence.numbers, evidence.set_codes] = findNumbers(index, evidence.pairs, candidates)
  }
  if (text) [evidence.text, evidence.rule_kinds] = findText(index, lines)
  evidence.suffix_of = index.suffix
  return evidence
}

export const evidenceEmpty = evidence => !(evidence.numbers.size || evidence.text.size || evidence.rule_kinds.size)

/** Cards worth bringing into the candidate list even when the picture search missed them. */
export function evidenceAddIds(evidence) {
  const out = []
  for (const hit of evidence.numbers.values()) if (hit.level !== 'number') out.push(hit.card_id)
  for (const [cardId, hit] of evidence.text) if (hit.cards <= TEXT_ADD_MAX_CARDS) out.push(cardId)
  return [...new Set(out)]
}

export function evidenceNumberBonus(evidence, cardId) {
  const hit = evidence.numbers.get(cardId)
  return hit ? LEVEL_BONUS[hit.level] : 0.0
}

export function evidenceBonus(evidence, cardId, { number = true } = {}) {
  let total = number ? evidenceNumberBonus(evidence, cardId) : 0.0
  const text = evidence.text.get(cardId)
  if (text) total += TEXT_WEIGHT * text.score
  if (evidence.rule_kinds.size && evidence.rule_kinds.has(evidence.suffix_of.get(cardId))) total += RULE_WEIGHT
  return total
}

export function evidenceLevelOf(evidence, cardId) {
  const hit = evidence.numbers.get(cardId)
  return hit ? hit.level : null
}

/** How many cards were found at ``level`` or a stronger one. */
export function evidenceUniqueAtOrAbove(evidence, level) {
  const limit = LEVEL_ORDER.indexOf(level)
  let count = 0
  for (const hit of evidence.numbers.values()) if (LEVEL_ORDER.indexOf(hit.level) <= limit) count += 1
  return count
}

export function evidenceTrace(evidence) {
  const numberHits = {}
  for (const level of LEVEL_ORDER) {
    const count = [...evidence.numbers.values()].filter(hit => hit.level === level).length
    if (count) numberHits[level] = count
  }
  const textHits = {}
  for (const [cardId, hit] of [...evidence.text].slice(0, 5)) textHits[cardId] = [pyRound(hit.score, 3), hit.cards, hit.via]
  return {
    pairs: evidence.pairs.slice(0, 4).map(pair => [...pair]),
    set_codes: evidence.set_codes.slice(0, 3),
    number_hits: numberHits,
    text_hits: textHits,
    rule: [...evidence.rule_kinds].sort(),
  }
}
