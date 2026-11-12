// The pure half of the text reader: what the number, set code and HP are, and which recognised line is the name.
// A port of backend/services/card_match/ocr.py (parse_text, pick_number_lines, completeness, better_read, merge_reads,
// is_name_like, find_hp) and names.py (clean_name_line, parse_name_lines), matcher version 11. Plain strings and plain
// objects only: no pictures, no models.
//
// One "reading" (Python's OcrResult) is a plain object:
//   { number, total, setCode, hp, tokens[], lines[{text, score, box}], complete, source, confidence,
//     seconds, flipped, attempts, strips[] }
// ``number``/``total`` are Python's number_local/number_total, ``source`` is number_source, ``confidence`` number_confidence.

export const SOURCE_FINDER_CARD = 'finder_card'
export const SOURCE_WHOLE_PICTURE = 'whole_picture'
export const ACCEPT_CONFIDENCE = 0.85 // a complete number this sure needs no second view (ocr.ACCEPT_CONFIDENCE)

// Python's \b is Unicode aware, JavaScript's is ASCII only: these two stand in for it.
const WORD = '[\\p{L}\\p{N}_]'
const BEFORE_WORD = `(?<!${WORD})`
const AFTER_WORD = `(?!${WORD})`

const NUMBER_TOTAL = /(?<![A-Za-z0-9])([A-Za-z]{0,4}\s?\d{1,3}[A-Za-z]?)\s*[/\\]\s*([A-Za-z]{0,4}\s?\d{1,3})/
const NUMBER_TOTAL_BAR = /(?<![A-Za-z0-9])([A-Za-z]{0,4}\d{1,3}[A-Za-z]?)\|([A-Za-z]{0,4}\d{1,3})/
const NUMBER_TOTAL_LOOSE = /(\d{1,3})(?:\s*[/\\]\s*|\|)([0-9OoIl|]{2,3})/
const NUMBER_GLUED = /(?<![A-Za-z0-9])[A-Za-z]{0,7}?\s?([0-9OoIlSZBDQ]{5,6})\s*$/
const PROMO = /(?<![A-Za-z0-9])(SWSH|SVP|SM|XY|BW|HGSS|DP|NP|SVE|MEP|MEE)\s?-?\s?(\d{1,3})(?![0-9/])/i
const HP_BEFORE = /(?:HP|PV|KP|PS|PF)\s*(\d{2,3})/i
const HP_AFTER = /(?<!\d)(\d{2,3})\s?HP/i
const TOKEN = /[A-Z0-9]{2,6}/g
const LANG_CODES = new Set(['EN', 'DE', 'FR', 'IT', 'ES', 'PT', 'JP', 'KO', 'NL', 'PL', 'RU', 'ID', 'TH', 'ZH'])

// Letters that really are part of a printed card number (lookup.NUMBER_PREFIXES); any other run of three or more letters in
// front of a number is the set code printed next to it.
const NUMBER_PREFIXES = new Set(['TG', 'GG', 'SV', 'RC', 'SWSH', 'SVP', 'SMP', 'SM', 'XYP', 'XY', 'BWP', 'BW', 'DP', 'HGSS', 'MEP', 'SH', 'PR', 'PRSV', 'PRSW', 'PRSM', 'H', 'S', 'P', 'NP', 'RT'])

export function isSetCodePrefix(letters) {
  const upper = String(letters || '').toUpperCase()
  return upper.length >= 3 && !NUMBER_PREFIXES.has(upper)
}

const DIGITISE = { O: '0', o: '0', D: '0', Q: '0', I: '1', l: '1', '|': '1', S: '5', B: '8', Z: '2' }
const digitise = text => Array.from(text, ch => DIGITISE[ch] ?? ch).join('')

/** Python's round(x, 3) for the confidences (the values are never exact ties). */
export const round3 = value => Number(value.toFixed(3))

export function emptyReading() {
  return { number: null, total: null, setCode: null, hp: null, tokens: [], lines: [], complete: false, source: null, confidence: null, seconds: 0, flipped: false, attempts: 0, strips: [] }
}

const asLine = item => (typeof item === 'string' ? { text: item, score: null, box: null } : item)

function cleanNumberPart(text) {
  text = text.replace(/\s+/g, '')
  const match = /^([A-Za-z]*)(\d{1,3}|[A-Za-z0-9]{1,3})([A-Za-z]?)$/.exec(text)
  if (!match) return text
  let [, prefix, body, suffix] = match
  if (LANG_CODES.has(prefix.toUpperCase())) prefix = '' // "SSP EN 038/270": the language code belongs to the set code
  if (isSetCodePrefix(prefix)) prefix = '' // "PBL039/084": PBL is the set code; the number is 039
  if (prefix.length === 1 && 'OoIlSBZDQ'.includes(prefix)) { // real prefixes are two letters or more: this is a misread digit
    body = digitise(prefix) + body
    prefix = ''
  }
  return `${prefix.toUpperCase()}${digitise(body)}${suffix.toUpperCase()}`
}

/** 0 nothing, 1 a number, 2 number and total (or a promo number, which has no total). */
export function completeness(reading) {
  if (!reading.number) return 0
  if (reading.total || /^[A-Z]{2,4}\d/.test(reading.number)) return 2
  return 1
}

export const isComplete = reading => completeness(reading) === 2

function gluedNumber(lines) {
  for (const line of lines) {
    const match = NUMBER_GLUED.exec(line.trim())
    if (!match) continue
    const blob = match[1]
    if ([...blob].filter(ch => ch >= '0' && ch <= '9').length < 4) continue
    const digits = digitise(blob)
    const split = digits.length === 6 ? 3 : 2
    const local = digits.slice(0, split)
    const total = digits.slice(split)
    if (/^\d+$/.test(digits) && parseInt(local, 10) > 0 && parseInt(total, 10) > 0) return [local, total]
  }
  return null
}

export function findHp(text) {
  const match = HP_BEFORE.exec(text) || HP_AFTER.exec(text)
  return match ? match[1] : null
}

/** Pull number/total, HP and set-code tokens out of recognised text lines (strings, or {text} objects). */
export function parseText(input) {
  const lines = input.map(asLine)
  const texts = lines.map(line => line.text)
  const reading = { ...emptyReading(), lines: [...lines] }
  const joined = texts.join('  ')
  const match = NUMBER_TOTAL.exec(joined) || NUMBER_TOTAL_BAR.exec(joined)
  let loose
  let glued
  if (match) {
    reading.number = cleanNumberPart(match[1])
    reading.total = cleanNumberPart(match[2])
  } else if ((loose = NUMBER_TOTAL_LOOSE.exec(joined))) {
    reading.number = cleanNumberPart(loose[1])
    reading.total = cleanNumberPart(loose[2])
  } else if ((glued = gluedNumber(texts))) {
    ;[reading.number, reading.total] = glued
  } else {
    const promo = PROMO.exec(joined)
    if (promo) reading.number = `${promo[1].toUpperCase()}${digitise(promo[2])}`
  }
  reading.hp = findHp(joined)
  for (const token of joined.toUpperCase().match(TOKEN) || []) {
    if (!LANG_CODES.has(token) && !reading.tokens.includes(token)) reading.tokens.push(token)
  }
  // Tokens glued to a number ("SVI018") also tell the set code; a language code off the end ("SVIEN018" -> "SVIEN" -> "SVI").
  for (const token of [...reading.tokens]) {
    const letters = /^([A-Z]{2,5})\d/.exec(token)
    if (letters && !reading.tokens.includes(letters[1])) reading.tokens.push(letters[1])
  }
  for (const token of [...reading.tokens]) {
    if (token.length > 4 && LANG_CODES.has(token.slice(-2)) && !reading.tokens.includes(token.slice(0, -2))) reading.tokens.push(token.slice(0, -2))
  }
  reading.complete = isComplete(reading)
  return reading
}

// ── Picking by pattern ───────────────────────────────────────────────────────

const SLASH_NUMBER = /\d{1,3}\s*[/|\\]\s*[0-9OoIl|]{2,3}/
const NOT_A_NAME = new RegExp(
  'nintendo|creatures|gamefreak|game\\s*freak|illus|©|\\(c\\)|' +
  `${BEFORE_WORD}turn${AFTER_WORD}|${BEFORE_WORD}you${AFTER_WORD}|${BEFORE_WORD}your${AFTER_WORD}|${BEFORE_WORD}damage${AFTER_WORD}|${BEFORE_WORD}attack|` +
  `${BEFORE_WORD}flip${AFTER_WORD}|knocked|${BEFORE_WORD}discard|opponent|${BEFORE_WORD}rule${AFTER_WORD}|${BEFORE_WORD}deck${AFTER_WORD}|` +
  `${BEFORE_WORD}cards?${AFTER_WORD}|${BEFORE_WORD}this${AFTER_WORD}|${BEFORE_WORD}prize|weakness|resistance|retreat|\\d{2,}/\\d{2,}`, 'iu')
const COPYRIGHT = /nintendo|creatures|game\s*freak|©|\(c\)|illus/i
export const MAX_NAME_CHARS = 28
export const MAX_NAME_WORDS = 4
const SMALL_WORDS = new Set(['of', 'the', 'and', 'de', 'du', 'la', 'van'])

// ── names.py: the reading half ───────────────────────────────────────────────

const STAGE_WORDS = new RegExp(String.raw`^(?:basic|stage\s*[12]|restored|vmax\s*climax|level\s*up)${AFTER_WORD}[\s:.\-]*`, 'iu')
const LABEL_ONLY = new Set([
  'item', 'supporter', 'stadium', 'trainer', 'tool', 'pokemon tool', 'pokémon tool', 'ace spec', 'technical machine',
  'energy', 'special energy', 'basic energy', 'basic', 'baby', 'mega', 'stage 1', 'stage 2', 'stage1', 'stage2', 'restored',
])
const EVOLVES = new RegExp(String.raw`${BEFORE_WORD}(?:evolves?\s+from|put\s+on)${AFTER_WORD}.*$`, 'iu')
const HP_TAIL = new RegExp(`\\s*(?:(?<![\\p{L}\\p{N}_])(?:hp|pv|kp|ps|pf)\\s*\\d{2,3}|\\d{2,3}\\s*hp)(?![\\p{L}\\p{N}_]).*$`, 'iu')
const NOT_NAME_CHARS = /[^A-Za-zÀ-ɏ0-9 '’&.\-:♀♂]/g
const LETTERS = /[A-Za-zÀ-ɏ]/g

/** One recognised line -> the part that can be a card name ('' when none). */
export function cleanNameLine(input) {
  let text = String(input ?? '').replace(HP_TAIL, '').trim()
  text = text.replace(EVOLVES, '').trim()
  for (let i = 0; i < 2; i++) { // "BASIC" then another label
    const stripped = text.replace(STAGE_WORDS, '').trim()
    if (stripped === text) break
    text = stripped
  }
  text = text.replace(NOT_NAME_CHARS, ' ')
  text = text.replace(/\s+/g, ' ').trim().replace(/^[ .:\-']+|[ .:\-']+$/g, '')
  // An energy symbol read as a stray digit at the end ("Pikachu 0").
  if (text.length > 4 && /[a-z]{3}/.test(text)) text = text.replace(/\s+\d{1,2}$/, '')
  if (LABEL_ONLY.has(text.toLowerCase())) return ''
  return (text.match(LETTERS) || []).length >= 2 ? text : ''
}

/** Could this recognised line be a card's name rather than body text, a copyright line or a number? */
export function isNameLike(text) {
  const cleaned = cleanNameLine(text)
  if ((cleaned.match(LETTERS) || []).length < 3 || cleaned.length > MAX_NAME_CHARS) return false
  if (NOT_A_NAME.test(cleaned) || COPYRIGHT.test(String(text ?? ''))) return false
  const words = cleaned.split(/\s+/).filter(Boolean)
  if (words.length > MAX_NAME_WORDS) return false
  const lower = words.filter(word => /^\p{Ll}/u.test(word) && !SMALL_WORDS.has(word.toLowerCase())).length
  return !(words.length >= 3 && lower * 2 >= words.length)
}

/**
 * Pick the card name from what OCR read in the top strip. ``items`` are strings, or {text, height} / [text, height]:
 * the tallest plausible line wins (the name is printed in the biggest type); without heights the longest does.
 */
export function parseNameLines(items) {
  const entries = items.map(item => {
    if (Array.isArray(item)) return [String(item[0] ?? ''), item[1] ?? null]
    if (item && typeof item === 'object') return [String(item.text ?? ''), item.height ?? null]
    return [String(item ?? ''), null]
  })
  const raw = entries.map(([text]) => text)
  const result = { name: null, raw, hp: findHp(raw.join('  ')) }
  let best = null
  for (const [text, height] of entries) {
    const cleaned = cleanNameLine(text)
    if (!cleaned) continue
    const score = (height || 0) * 10 + cleaned.length
    if (best === null || score > best[0]) best = [score, cleaned]
  }
  result.name = best ? best[1] : null
  return result
}

// ── Number lines ─────────────────────────────────────────────────────────────

/**
 * The number and total from recognised lines ({text, score}), and the confidence of the line that carried them. A single
 * line holding a whole "018/091" (or the glued "018091") wins over a number stitched together from neighbouring lines;
 * with several, the one with a real slash, then the most confident. Returns {reading, confidence}.
 */
export function pickNumberLines(lines) {
  lines = lines.map(asLine)
  let best = null
  for (const line of lines) {
    const single = parseText([line.text])
    if (single.number && single.total) {
      const key = [SLASH_NUMBER.test(line.text) ? 1 : 0, line.score ?? 0]
      if (best === null || key[0] > best[0][0] || (key[0] === best[0][0] && key[1] > best[0][1])) best = [key, single]
    }
  }
  const reading = parseText(lines)
  if (best !== null) {
    reading.number = best[1].number
    reading.total = best[1].total
    reading.complete = isComplete(reading)
    return { reading, confidence: round3(best[0][1]) }
  }
  const carriers = lines.filter(line => PROMO.test(line.text)).map(line => line.score ?? 0)
  return { reading, confidence: carriers.length && reading.number ? round3(carriers.reduce((a, b) => a + b, 0) / carriers.length) : null }
}

/** The more useful of two readings of the same card: more complete, then more confident; agreement raises the confidence. */
export function betterRead(old, next) {
  if (old === null || old === undefined) return next
  if (old.number && old.number === next.number && old.total === next.total) {
    old.confidence = round3(Math.min(1.0, Math.max(old.confidence || 0.0, next.confidence || 0.0) + 0.1))
    for (const token of next.tokens) if (!old.tokens.includes(token)) old.tokens.push(token)
    return old
  }
  const oldKey = [completeness(old), old.confidence || 0.0]
  const nextKey = [completeness(next), next.confidence || 0.0]
  const nextWins = nextKey[0] > oldKey[0] || (nextKey[0] === oldKey[0] && nextKey[1] > oldKey[1])
  const [winner, loser] = nextWins ? [next, old] : [old, next]
  for (const token of loser.tokens) if (!winner.tokens.includes(token)) winner.tokens.push(token)
  return winner
}

/**
 * ``old`` and a second reading of the same scan as one: the more useful number by ``betterRead``, every line and region
 * read kept (regions of ``next`` are tagged ``source`` and their labels start with ``prefix``). With a ``source``, a number
 * that came from the second reading says so; otherwise it is tagged as the finder's card.
 */
export function mergeReads(old, next, source = null, prefix = '') {
  const strips = [...old.strips, ...next.strips.map(strip => (source ? { ...strip, source, label: `${prefix}${strip.label}` } : { ...strip }))]
  const lines = [...old.lines, ...next.lines]
  const seconds = old.seconds + next.seconds
  const attempts = old.attempts + next.attempts
  const hp = old.hp || next.hp
  const flipped = old.flipped
  const merged = betterRead(old, next)
  if (merged === next && next.number) merged.source = source || SOURCE_FINDER_CARD
  else if (merged.number && !merged.source) merged.source = SOURCE_FINDER_CARD
  Object.assign(merged, { strips, lines, seconds, attempts, hp, flipped })
  merged.complete = isComplete(merged)
  return merged
}
