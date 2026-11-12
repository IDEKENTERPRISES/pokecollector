import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { betterRead, cleanNameLine, completeness, emptyReading, findHp, isComplete, isNameLike, mergeReads, parseNameLines, parseText, pickNumberLines } from './parse'
import { readFixture } from './testkit'

// Step 1's recorded answers (pure-functions.json) and this step's (ocr/ocr-pure.json): the Python functions' own output.
const step1 = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'phone-matcher', 'v11', 'pure-functions.json'), 'utf-8'))
const own = readFixture('ocr-pure.json')

const fields = r => ({ number: r.number, total: r.total, hp: r.hp, tokens: r.tokens })

describe('number parsing (ocr.parse_text, pick_number_lines)', () => {
  it('matches the step 1 parse_text answers', () => {
    expect(step1.parse_text.length).toBeGreaterThan(5)
    for (const item of step1.parse_text) {
      const got = parseText(item.input)
      expect(fields(got), JSON.stringify(item.input)).toEqual({ number: item.output.number_local, total: item.output.number_total, hp: item.output.hp, tokens: item.output.tokens })
    }
  })

  it('matches the step 1 pick_number_lines answers', () => {
    for (const item of step1.pick_number_lines) {
      const { reading, confidence } = pickNumberLines(item.input)
      expect({ ...fields(reading), confidence }).toEqual({ number: item.output.number_local, total: item.output.number_total, hp: item.output.hp, tokens: item.output.tokens, confidence: item.output.confidence })
    }
  })

  it('matches the added parse_text cases', () => {
    expect(own.parse_text.length).toBeGreaterThan(30)
    for (const item of own.parse_text) {
      const got = parseText(item.input)
      expect({ ...fields(got), complete: got.complete, completeness: completeness(got) }, JSON.stringify(item.input)).toEqual(item.output)
    }
  })

  it('matches the added pick_number_lines cases', () => {
    for (const item of own.pick_number_lines) {
      const { reading, confidence } = pickNumberLines(item.input)
      expect({ ...fields(reading), confidence }, JSON.stringify(item.input)).toEqual(item.output)
    }
  })

  it('finds the HP', () => {
    for (const item of own.find_hp) expect(findHp(item.input), item.input).toBe(item.output)
  })

  it('says complete for a number with a total, or a promo number', () => {
    expect(isComplete(parseText(['125/197']))).toBe(true)
    expect(isComplete(parseText(['SWSH001']))).toBe(true)
    expect(completeness(parseText(['no number']))).toBe(0)
    expect(completeness({ ...emptyReading(), number: '018' })).toBe(1)
  })
})

describe('names (names.clean_name_line, parse_name_lines, ocr.is_name_like)', () => {
  it('matches the step 1 answers', () => {
    for (const item of step1.is_name_like) expect(isNameLike(item.input), item.input).toBe(item.output)
    for (const item of step1.parse_name_lines) {
      const read = parseNameLines(item.input)
      expect({ name: read.name, hp: read.hp }).toEqual(item.output)
    }
    for (const item of step1.name_keys) expect(cleanNameLine(item.input)).toBe(item.clean_line)
  })

  it('matches the added cases', () => {
    expect(own.clean_name_line.length).toBeGreaterThan(30)
    for (const item of own.clean_name_line) expect(cleanNameLine(item.input), JSON.stringify(item.input)).toBe(item.output)
    for (const item of own.is_name_like) expect(isNameLike(item.input), JSON.stringify(item.input)).toBe(item.output)
    for (const item of own.parse_name_lines) {
      const read = parseNameLines(item.input)
      expect({ name: read.name, hp: read.hp, raw: read.raw }, JSON.stringify(item.input)).toEqual(item.output)
    }
  })
})

describe('merging two readings (better_read, merge_reads)', () => {
  const build = (lines, confidence, source) => {
    const reading = parseText(lines)
    reading.confidence = confidence
    reading.source = source
    return reading
  }

  it('matches the recorded merges', () => {
    expect(own.merge_reads.length).toBeGreaterThan(8)
    for (const [index, item] of own.merge_reads.entries()) {
      const old = build(item.old.lines, item.old.confidence, item.old.source)
      const next = build(item.new.lines, item.new.confidence, null)
      old.strips = [{ label: 'a' }, { label: 'b' }]
      next.strips = [{ label: 'c' }]
      Object.assign(old, { seconds: 0.5, attempts: 2 })
      Object.assign(next, { seconds: 0.25, attempts: 1 })
      const merged = mergeReads(old, next, item.source, item.prefix)
      const expected = item.output
      expect({
        number: merged.number, total: merged.total, hp: merged.hp, tokens: merged.tokens, confidence: merged.confidence, source: merged.source,
        seconds: merged.seconds, attempts: merged.attempts, flipped: merged.flipped, lines: merged.lines.map(line => line.text),
        strips: merged.strips.map(strip => ({ label: strip.label, source: strip.source ?? null })),
      }, `scenario ${index}`).toEqual({
        number: expected.number, total: expected.total, hp: expected.hp, tokens: expected.tokens, confidence: expected.confidence, source: expected.source,
        seconds: expected.seconds, attempts: expected.attempts, flipped: expected.flipped, lines: expected.lines, strips: expected.strips.map(s => ({ label: s.label, source: s.source ?? null })),
      })
    }
  })

  it('raises the confidence when two readings agree, and keeps the more complete one otherwise', () => {
    const agree = betterRead(build(['018/091'], 0.9, null), build(['018/091'], 0.8, null))
    expect(agree.confidence).toBe(1)
    const complete = betterRead(build(['018'], 0.99, null), build(['018/091'], 0.4, null))
    expect(complete.total).toBe('091')
  })
})
