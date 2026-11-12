import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { completeness } from './parse'
import { characterTable } from './recognise'
import { mergeReads, readCard, readName, readWhole, secondRead } from './reader'
import { OCR_FIXTURES, loadCard, readFixture, replaySessions } from './testkit'

const reference = readFixture('ocr-cases.json')
const characters = characterTable(readFileSync(resolve(OCR_FIXTURES, 'characters.txt'), 'utf-8'))
const SCORE_TOLERANCE = 1e-3

function cutCard(card, spec) {
  const keep = Math.trunc(card.height * spec.cut_fraction)
  const out = { data: new Uint8ClampedArray(card.data), width: card.width, height: card.height }
  for (let i = keep * card.width * 4; i < out.data.length; i += 4) out.data.set([spec.fill, spec.fill, spec.fill, 255], i)
  return out
}

const stripsOf = strips => strips.map(s => ({ label: s.label, variant: s.variant, zoom: s.zoom, low: s.low, flipped: s.flipped, cached: Boolean(s.cached), after: s.after ?? null, source: s.source ?? null }))

function expectStripLines(got, want, where) {
  expect(got.length, where).toBe(want.length)
  got.forEach((strip, i) => {
    expect(strip.lines.map(l => l.text), `${where} strip ${i} text`).toEqual(want[i].lines.map(l => l.text))
    strip.lines.forEach((line, k) => expect(Math.abs(line.score - want[i].lines[k].score), `${where} strip ${i} score`).toBeLessThanOrEqual(SCORE_TOLERANCE))
  })
}

function expectReading(got, want, where) {
  expect({ number: got.number, total: got.total, hp: got.hp, tokens: got.tokens }, where).toEqual({ number: want.number, total: want.total, hp: want.hp, tokens: want.tokens })
  expect(got.lines.map(line => line.text), `${where} lines`).toEqual(want.lines)
  if (want.confidence === null) expect(got.confidence, where).toBeNull()
  else expect(Math.abs(got.confidence - want.confidence), `${where} confidence`).toBeLessThanOrEqual(SCORE_TOLERANCE)
  expect(got.source, `${where} source`).toBe(want.source ?? (want.number ? 'finder_card' : null)) // the pipeline tags an untagged number as the finder's card
  expect(got.attempts, `${where} attempts`).toBe(want.attempts)
  expect(got.flipped, `${where} flipped`).toBe(want.flipped)
  expect(stripsOf(got.strips), `${where} strips`).toEqual(stripsOf(want.strips))
  expectStripLines(got.strips, want.strips, where)
  expect(got.complete).toBe(completeness(got) === 2)
}

describe('the text reader replays what the Python reader read (no time budget)', () => {
  it('has the recordings', () => {
    expect(reference.cases.length).toBeGreaterThan(15)
    expect(characters.length).toBe(reference.classes)
  })

  for (const item of reference.cases) {
    it(`${item.id} (${item.kind}): same number, total, HP, name, lines and regions read`, async () => {
      const card = loadCard(item.file)
      expect([card.width, card.height]).toEqual(item.size)
      const sessions = replaySessions(item.events, characters)
      if (item.kind === 'read') {
        const got = await readCard(sessions, card, { fast: true, flipped: item.flipped, budget: null })
        expectReading(got, item.result, item.id)
      } else if (item.kind === 'read_name') {
        const got = await readName(sessions, card, { fast: true, flipped: item.flipped, budget: null })
        expect(got.name).toBe(item.result.name)
        expect(got.hp).toBe(item.result.hp)
        expect(got.raw).toEqual(item.result.raw)
        expect(stripsOf(got.strips)).toEqual(stripsOf(item.result.strips))
        expectStripLines(got.strips, item.result.strips, item.id)
        if (got.name) expect(got.confidence).toBeGreaterThan(0.5)
      } else {
        const textCard = cutCard(card, item.text_card)
        const first = await readCard(sessions, textCard, { fast: true, flipped: false, stage: 'first', budget: null })
        expect(completeness(first) === 2).toBe(item.first_complete)
        const { reading, info } = await secondRead(sessions, { first, wholeImage: card, textCard, flipped: false, budget: null })
        expectReading(reading, item.result, item.id)
        expect({ tried: info.tried, skipped: info.skipped, rescued: info.rescued, last_resort: info.last_resort }).toEqual(item.info)
      }
      expect(sessions.mismatches, 'model inputs').toEqual([])
      expect(sessions.used, 'every recorded call was made').toBe(item.events.length)
    })
  }
})

describe('the text reader as a library', () => {
  const blank = { data: new Uint8ClampedArray(64 * 88 * 4).fill(255), width: 64, height: 88 }
  const silent = { characters, detect: () => ({ data: new Float32Array(64 * 96), width: 64, height: 96 }), recognise: () => { throw new Error('nothing to recognise') } }

  it('reads nothing from a blank card, and reports the time it took with an injected clock', async () => {
    let t = 0
    const got = await readCard(silent, blank, { now: () => (t += 0.01) })
    expect(got.number).toBeNull()
    expect(got.complete).toBe(false)
    expect(got.lines).toEqual([])
    expect(got.seconds).toBeGreaterThan(0)
  })

  it('stops the ladder when the budget is spent (the second step is not read)', async () => {
    let calls = 0
    const sessions = { ...silent, detect: map => { calls++; return silent.detect(map) } }
    let t = 0
    const got = await readCard(sessions, blank, { stage: 'first', readHp: false, budget: 0.5, now: () => (t += 1) }) // every clock read costs a second
    expect(got.attempts).toBe(1)
    expect(calls).toBe(1)
  })

  it('without a budget reads the whole ladder: six steps and the last-resort band', async () => {
    const got = await readCard(silent, blank, { readHp: false })
    expect(got.attempts).toBe(6)
    expect(got.strips.map(s => s.label)).toEqual(['number-left-tight', 'number-right-tight', 'bottom-band', 'number-left-wide', 'number-right-wide', 'bottom-band', 'bottom-wide'])
  })

  it('readWhole reads the first three steps only, and mergeReads labels what came from the whole picture', async () => {
    const whole = await readWhole(silent, blank, { budget: null })
    expect(whole.strips.map(s => s.label)).toEqual(['number-left-tight', 'number-right-tight', 'bottom-band'])
    const first = await readCard(silent, blank, { stage: 'first', readHp: false })
    const merged = mergeReads(first, whole, 'whole_picture', 'whole-')
    expect(merged.strips.slice(-3).map(s => `${s.source}:${s.label}`)).toEqual(['whole_picture:whole-number-left-tight', 'whole_picture:whole-number-right-tight', 'whole_picture:whole-bottom-band'])
  })
})
