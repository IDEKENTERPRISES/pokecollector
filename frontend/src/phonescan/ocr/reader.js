// The text reader: the number ladder, the name ladder and the whole-picture second read, ported from OcrReader (ocr.py,
// matcher version 11) and names.py. The fast ladders only (``fastread``): the slow ``binary`` and ``deglare`` steps are not ported.
//
// ``sessions`` = {detect(tensor) -> map, recognise(tensor) -> logits, characters} where tensors are {data, dims}, the detector's
// map is a probability map ({data, dims [1, 1, H, W]} or {data, width, height}), the recogniser's output is [n, steps, classes]
// probabilities (or the compact {steps, indices, values}) and ``characters`` is the character table from ``characterTable``.
// Both session calls may be synchronous or return promises, so a test can feed recorded model outputs.
//
// ``card`` / ``wholeImage`` = {data: RGBA bytes, width, height}.
// Time: the server stops a ladder after FAST_BUDGET_SECONDS. Here ``budget`` (seconds, or null for no limit) is a parameter and
// ``now`` (seconds, default the performance clock) is injectable, so results need not depend on the device's speed.
import { cropFraction, resizeCubicZoom, prepare, rotate180, warpBox } from './image'
import { detectBoxes, detectionInput } from './detect'
import { batchesOf, ctcDecodeBatch, recognitionBatch } from './recognise'
import {
  ACCEPT_CONFIDENCE, SOURCE_FINDER_CARD, SOURCE_WHOLE_PICTURE, betterRead, cleanNameLine, completeness, emptyReading, findHp, isComplete,
  isNameLike, mergeReads, parseNameLines, parseText, pickNumberLines, round3,
} from './parse'

export { SOURCE_FINDER_CARD, SOURCE_WHOLE_PICTURE, ACCEPT_CONFIDENCE }

const NAME_STRIP = [0.03, 0.02, 1.0, 0.15] // names.NAME_STRIP
const NAME_ZOOM = 2.0
const WIDE_ZOOM = 3.0
const REFERENCE_HEIGHT = 880
const HP_STRIP = [0.45, 0.0, 1.0, 0.14]
const STRIPS = { tight: [[0.0, 0.945, 0.55, 1.0], [0.45, 0.945, 1.0, 1.0]], wide: [[0.0, 0.905, 0.55, 1.0], [0.45, 0.905, 1.0, 1.0]] }
const BOTTOM_BAND = [0.0, 0.885, 1.0, 1.0]
const NAME_BAND = [0.03, 0.015, 0.8, 0.115]
const EXPANDED = { top: [0.0, 0.0, 1.0, 0.24], bottom: [0.0, 0.72, 1.0, 1.0] }
const WHOLE_SIDE = 960
const QUICK_STEPS = 3

export const FAST_BUDGET_SECONDS = 0.9 // what the server uses; the phone chooses its own (docs/phone-scanner/ocr.md)
export const WHOLEREAD_TOTAL = 1.5
export const WHOLEREAD_MAX_SECONDS = 0.45
export const WHOLEREAD_MIN_SECONDS = 0.15

// [label, box, variant, zoom, low thresholds]; the slow binary / deglare steps are left out, so these are the fast ladders.
export const NUMBER_LADDER_FAST = [
  ['number-left-tight', STRIPS.tight[0], 'plain', 2.0, false],
  ['number-right-tight', STRIPS.tight[1], 'plain', 2.0, false],
  ['bottom-band', BOTTOM_BAND, 'plain', 3.0, true],
  ['number-left-wide', STRIPS.wide[0], 'sharp', WIDE_ZOOM, false],
  ['number-right-wide', STRIPS.wide[1], 'sharp', WIDE_ZOOM, false],
  ['bottom-band', BOTTOM_BAND, 'clahe', 2.5, true],
]
export const NAME_LADDER_FAST = [
  ['name-line', null, 'plain', 2.0, false], // null: NAME_STRIP, read at NAME_ZOOM
  ['name-band', NAME_BAND, 'clahe', 2.5, true],
]

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000

class Reader {
  constructor(sessions, options) {
    this.sessions = sessions
    this.now = options.now || defaultNow
    this.cache = options.cache || new WeakMap() // the last-resort bands read once per card and side
  }

  /** One RapidOCR call on a picture: lines {text, score, box [x0, y0, x1, y1]} left to right. */
  async run(picture, low) {
    const side = Math.trunc(Math.min(WHOLE_SIDE, Math.max(480, Math.max(picture.width, picture.height))))
    const prepared = detectionInput(picture, side)
    if (!prepared) return []
    const map = await this.sessions.detect(prepared.tensor)
    const boxes = detectBoxes(map, prepared.image.width, prepared.image.height, { boxThresh: low ? 0.35 : 0.5 })
    if (!boxes.length) return []
    const crops = boxes.map(box => warpBox(prepared.image, box.points))
    const results = new Array(crops.length)
    for (const indices of batchesOf(crops)) {
      const logits = await this.sessions.recognise(recognitionBatch(crops, indices))
      ctcDecodeBatch(logits, this.sessions.characters).forEach((res, n) => { results[indices[n]] = res })
    }
    const lines = []
    const textScore = low ? 0.4 : 0.5
    boxes.forEach((box, i) => {
      if (!(results[i].score >= textScore)) return
      const xs = box.points.map(p => p[0])
      const ys = box.points.map(p => p[1] - prepared.pad)
      lines.push({ text: results[i].text, score: results[i].score, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] })
    })
    return lines.sort((a, b) => a.box[0] - b.box[0])
  }

  zoomFor(card, zoom) {
    return card.height > REFERENCE_HEIGHT ? Math.max(1.0, zoom * REFERENCE_HEIGHT / card.height) : zoom
  }

  /** Read one region; null when the variant changes nothing for it. Appends what was read to ``record``. */
  async scan(card, label, box, variant, zoom, low, record, flipped) {
    const crop = cropFraction(card, box)
    if (!crop.width || !crop.height) return null
    const zoomed = this.zoomFor(card, zoom)
    const began = this.now()
    const strip = prepare(resizeCubicZoom(crop, zoomed), variant)
    if (strip === null) return null
    const lines = await this.run(strip, low)
    record.push({
      label, box: box.map(v => Number(v.toFixed(4))), variant, zoom: round3(zoomed), low, flipped,
      ms: Math.round((this.now() - began) * 10000) / 10, lines: lines.slice(0, 14).map(line => ({ text: line.text, score: round3(line.score) })),
    })
    return lines
  }

  /** The last resort: a much taller band at the top or the bottom (cached per card and side). */
  async expanded(card, record, flipped, which) {
    let byCard = this.cache.get(card)
    if (!byCard) this.cache.set(card, (byCard = new Map()))
    const key = `${flipped}:${which}`
    if (!byCard.has(key)) {
      const scratch = []
      const lines = (await this.scan(card, `${which}-wide`, EXPANDED[which], 'clahe', 2.0, true, scratch, flipped)) || []
      byCard.set(key, { lines, record: scratch[0] })
      record.push({ ...scratch[0] })
    } else {
      record.push({ ...byCard.get(key).record, ms: 0.0, cached: true })
    }
    return byCard.get(key).lines
  }
}

const overBudget = (reader, started, budget, factor = 1) => budget !== null && reader.now() - started > budget * factor

function turned(card) {
  return rotate180(card)
}

/** The number ladder (OcrReader._read_card). */
async function readNumber(reader, card, { fast, stage, budget, flipped, maxSteps = null, acceptConfidence = ACCEPT_CONFIDENCE }) {
  const record = []
  const started = reader.now()
  let ladder = fast ? NUMBER_LADDER_FAST : NUMBER_LADDER_FAST // the slow steps are not ported: the phone reads the fast ladder
  if (stage === 'quick') ladder = NUMBER_LADDER_FAST.slice(0, QUICK_STEPS)
  else if (stage === 'last') ladder = []
  if (maxSteps !== null) ladder = ladder.slice(0, maxSteps) // a leaner ladder (an option of the phone: the default is the server's)
  let lines = []
  let best = null
  let reads = 0
  let stopped = 'end'
  for (const [label, box, variant, zoom, low] of ladder) {
    if (best !== null && completeness(best) === 2 && (best.confidence || 0.0) >= acceptConfidence) { stopped = 'accepted'; break }
    if (reads && overBudget(reader, started, budget)) { stopped = 'budget'; break }
    const got = await reader.scan(card, label, box, variant, zoom, low, record, flipped)
    if (got === null) continue
    reads++
    lines = lines.concat(got)
    if (label.includes('band')) { // independent readings of the same area, merged by agreement
      const { reading, confidence } = pickNumberLines(got)
      reading.confidence = confidence
      best = betterRead(best, reading)
    } else { // the strips are halves of one reading: pick from everything read so far
      const { reading, confidence } = pickNumberLines(lines)
      best = reading
      best.confidence = confidence
    }
    record[record.length - 1].after = { number: best.number, total: best.total }
  }
  if ((best === null || completeness(best) < 2) && (stage === 'all' || stage === 'last') && !overBudget(reader, started, budget, 1.5)) {
    const bottom = await reader.expanded(card, record, flipped, 'bottom')
    lines = lines.concat(bottom)
    const { reading, confidence } = pickNumberLines(bottom)
    reading.confidence = confidence
    best = best !== null ? betterRead(best, reading) : reading
    record[record.length - 1].after = { number: best.number, total: best.total }
  }
  const result = best || parseText([])
  result.lines = lines.map(line => ({ text: line.text, score: line.score, box: line.box }))
  result.attempts = reads
  result.stopped = stopped // 'accepted' (a complete, sure number), 'budget' (the time budget ran out) or 'end' (every step ran)
  result.strips = record
  result.complete = isComplete(result)
  return result
}

/**
 * Read the collector number and set total, set code and HP from a flat card (OcrReader.read), fast ladder.
 *
 * Options: ``fast`` (kept for the server's name; this port only has the fast ladder), ``flipped`` (true: the card is read
 * turned 180 degrees; false, the default: upright; null: upright, and turned too when no complete number came out),
 * ``readHp`` (default true), ``maxSteps`` / ``acceptConfidence`` (a leaner ladder: only the first steps, a lower confidence that ends it; the defaults are the server's), ``stage`` ("all" | "first" | "quick" | "last", see the docs), ``budget`` (seconds, default none),
 * ``now`` (a clock in seconds), ``setCodes`` (a Set of known set codes, to fill ``setCode``).
 */
export async function readCard(sessions, card, options = {}) {
  const { fast = true, flipped = false, readHp = true, stage = 'all', budget = null, setCodes = null, maxSteps = null, acceptConfidence = ACCEPT_CONFIDENCE } = options
  const reader = new Reader(sessions, options)
  const started = reader.now()
  let isTurned = Boolean(flipped)
  let picture = isTurned ? turned(card) : card
  const params = { fast, stage, budget, maxSteps, acceptConfidence }
  let result = await readNumber(reader, picture, { ...params, flipped: isTurned })
  if (flipped === null && !isComplete(result)) {
    const other = turned(picture)
    const retry = await readNumber(reader, other, { ...params, flipped: !isTurned })
    if (completeness(retry) > completeness(result)) {
      result = retry
      picture = other
      isTurned = !isTurned
    } else {
      result.strips = result.strips.concat(retry.strips)
    }
  }
  result.flipped = isTurned
  if (readHp) {
    const hpRecord = result.strips
    const hpLines = (await reader.scan(picture, 'hp', HP_STRIP, 'plain', 2.0, false, hpRecord, isTurned)) || []
    const hpText = hpLines.map(line => line.text)
    const hp = findHp(hpText.join('  '))
    if (hp) result.hp = hp
    else { // "HP" and the figure on separate lines, or the HP word misread
      const figures = (hpText.join(' ').match(/(?<!\d)(\d{2,3})(?!\d)/g) || []).map(Number)
      const found = figures.find(v => v >= 30 && v <= 340 && v % 10 === 0)
      result.hp = found === undefined ? null : String(found)
    }
    result.lines = result.lines.concat(hpLines.map(line => ({ ...line, text: `[hp] ${line.text}` })))
  }
  result.seconds = round3(reader.now() - started)
  if (result.number && !result.source) result.source = SOURCE_FINDER_CARD
  if (setCodes) {
    const known = new Set([...setCodes].filter(Boolean).map(code => code.toUpperCase()))
    result.setCode = result.tokens.find(token => known.has(token)) ?? null
  }
  result.complete = isComplete(result)
  return result
}

/**
 * The name line (and the HP) at the top of the flat card (OcrReader.read_name), fast ladder. Returns {name, lines, confidence,
 * hp, raw, strips}: ``lines`` every line read ({text, score, box}), ``confidence`` the recogniser score of the line the name
 * was taken from (null without a name).
 */
export async function readName(sessions, card, options = {}) {
  const { flipped = false, budget = null } = options
  const reader = new Reader(sessions, options)
  const started = reader.now()
  const picture = flipped ? turned(card) : card
  const record = []
  let found = []
  let allLines = []
  const heights = lines => lines.map(line => [line.text, line.box[3] - line.box[1]])
  for (const [label, box, variant, zoom, low] of NAME_LADDER_FAST) {
    if (found.length || (allLines.length && overBudget(reader, started, budget))) break
    const lines = await reader.scan(picture, label, box || NAME_STRIP, variant, box ? zoom : NAME_ZOOM, low, record, flipped)
    if (lines === null) continue
    allLines = allLines.concat(lines)
    found = lines.filter(line => isNameLike(line.text))
    record[record.length - 1].after = { name: parseNameLines(heights(found)).name }
  }
  if (!found.length && !overBudget(reader, started, budget, 1.5)) {
    const top = await reader.expanded(picture, record, flipped, 'top')
    allLines = allLines.concat(top)
    found = top.filter(line => isNameLike(line.text) && line.box[3] / record[record.length - 1].zoom / picture.height <= 0.2)
    record[record.length - 1].after = { name: parseNameLines(heights(found)).name }
  }
  const read = parseNameLines(heights(found))
  const source = found.find(line => cleanNameLine(line.text) === read.name)
  return {
    name: read.name,
    lines: allLines.map(line => ({ text: line.text, score: line.score, box: line.box })),
    confidence: source ? round3(source.score) : null,
    hp: read.hp || findHp(allLines.map(line => line.text).join('  ')),
    raw: allLines.map(line => line.text).slice(0, 12),
    strips: record,
  }
}

/**
 * The whole-picture second read (matcher version 9, ``wholeread``): the same number read on the whole photo treated as the
 * card, the first ``QUICK_STEPS`` steps only (the two tight strips and the plain bottom band), no HP. Returns the same
 * shape as ``readCard``; ``secondRead`` merges it with the first reading.
 */
export function readWhole(sessions, wholeImage, options = {}) {
  const { budget = WHOLEREAD_MAX_SECONDS } = options
  return readCard(sessions, wholeImage, { ...options, stage: 'quick', readHp: false, budget })
}

/**
 * Version 9 (``wholeread``) as the pipeline runs it (pipeline._second_read): the finder's card gave no complete number, so read
 * the whole picture once more, merge by ``betterRead`` and label the second reading's regions ``whole-``/``whole_picture``; then,
 * when the number is still incomplete and time is left, the last-resort band the first read held back (``stage: "last"``) on the
 * finder's card. ``first`` is the first reading (read with ``stage: "first"``), ``wholeImage`` the whole picture (its sharper copy
 * when it has one), ``textCard`` the finder's card. Options: ``flipped``, ``fast``, ``budget`` (seconds of the first read's
 * ladder: the allowance is budget x 1.5; null = no limit), ``now``. Returns {reading, info: {tried, skipped, rescued, last_resort, ms}}.
 */
export async function secondRead(sessions, { first, wholeImage, textCard, flipped = false, fast = true, budget = null, now = defaultNow }) {
  const began = now()
  const total = budget === null ? Infinity : budget * WHOLEREAD_TOTAL
  let spent = first.seconds || 0
  const info = { tried: false, skipped: null, rescued: false, last_resort: null }
  const before = completeness(first)
  let result = first
  const left = total - spent
  if (left >= WHOLEREAD_MIN_SECONDS) {
    const second = await readWhole(sessions, wholeImage, { flipped, fast, now, budget: Math.min(WHOLEREAD_MAX_SECONDS, left) })
    result = mergeReads(first, second, SOURCE_WHOLE_PICTURE, 'whole-')
    info.tried = true
    spent += second.seconds || 0
  } else {
    info.skipped = 'budget'
  }
  if (!isComplete(result)) { // what the first read held back
    if (spent <= total) {
      const last = await readCard(sessions, textCard, { flipped, fast, now, stage: 'last', readHp: false, budget })
      result = mergeReads(result, last)
      info.last_resort = 'read'
    } else {
      info.last_resort = 'skipped'
    }
  }
  info.rescued = completeness(result) > before
  info.ms = Math.round((now() - began) * 10000) / 10
  if (result.number && !result.source) result.source = SOURCE_FINDER_CARD
  return { reading: result, info }
}

export { mergeReads, emptyReading }
