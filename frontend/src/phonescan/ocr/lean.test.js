// The cost of a leaner number ladder (step 3d fix): the phone may stop after the first steps. The default is the server's ladder and the parity tests
// above check it; this file measures what the lean option would change on the same recordings (the first N steps are a prefix of the recorded calls,
// so they can be replayed). "Lean" never makes a new number: it can only lose one the later steps would have found, or end earlier on a number the later steps would have confirmed.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { characterTable } from './recognise'
import { readCard } from './reader'
import { OCR_FIXTURES, loadCard, readFixture, replaySessions } from './testkit'

const reference = readFixture('ocr-cases.json')
const characters = characterTable(readFileSync(resolve(OCR_FIXTURES, 'characters.txt'), 'utf-8'))

async function compare(maxSteps) {
  const rows = []
  for (const item of reference.cases.filter(c => c.kind === 'read')) {
    const sessions = replaySessions(item.events, characters)
    const got = await readCard(sessions, loadCard(item.file), { fast: true, flipped: item.flipped, budget: null, stage: 'first', maxSteps })
    rows.push({ id: item.id, calls: sessions.used, of: item.events.length, same: got.number === item.result.number && got.total === item.result.total, got: `${got.number}/${got.total}`, want: `${item.result.number}/${item.result.total}` })
  }
  return rows
}

describe('the lean ladder on the recorded reads', () => {
  for (const steps of [2, 3, 4]) {
    it(`first ${steps} steps (no last-resort band)`, async () => {
      const rows = await compare(steps)
      const changed = rows.filter(row => !row.same)

      expect(rows.length).toBeGreaterThan(5)
      expect(changed).toEqual([]) // generated cards are clean, so this is the best case: real photos are what the iPhone run measures
    })
  }
})
