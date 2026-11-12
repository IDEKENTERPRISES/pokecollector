// Parity with the Python matcher's answers recorded by backend/scripts/phone_parity_fixtures.py (step 1):
// the parts of pure-functions.json that belong to the lookup and the decision (the text parsing cases are the reader's).
import { describe, expect, it } from 'vitest'
import fixture from '../../../tests/fixtures/phone-matcher/v11/pure-functions.json'
import { constrain } from './constrained.js'
import { buildLookupIndex, cardTexts, evidenceTrace, numberPairs, searchLookup } from './lookup.js'
import { baseKey, buildNameIndex, nameKey, searchNames } from './names.js'
import { decide } from './pipeline.js'
import { DEFAULT_THRESHOLDS, thresholdsFromManifest } from './thresholds.js'
import { pyRound } from './pyCompat.js'

describe('name keys', () => {
  for (const item of fixture.name_keys) {
    it(`${item.input}`, () => {
      expect(nameKey(item.input)).toBe(item.key)
      expect(baseKey(item.input)).toBe(item.base_key)
    })
  }
})

const nameRows = fixture.lookup_rows.map(row => ({ card_id: row.card_id, name: row.name, number: row.number, printed_total: row.printed_total }))
const nameIndex = buildNameIndex(nameRows)

describe('name search', () => {
  for (const item of fixture.name_search) {
    it(`${item.input.name}`, () => {
      const hits = searchNames(nameIndex, item.input.name, item.input.number, item.input.total)
      expect(hits.map(hit => [hit.card_id, pyRound(hit.name_score, 4), hit.number_ok, hit.total_ok])).toEqual(item.output)
    })
  }
})

describe('constrained reading', () => {
  for (const item of fixture.constrain) {
    it(JSON.stringify(item.input.lines), () => {
      expect(constrain(item.input.lines, item.input.candidates)).toEqual(item.output === null ? null : {
        ...item.output, distance: item.output.distance, runner_up: item.output.runner_up,
      })
    })
  }
})

const lookupRows = fixture.lookup_rows.map(row => ({
  card_id: row.card_id,
  name: row.name,
  number: row.number,
  printed_total: row.printed_total,
  set_id: row.set_id,
  suffix: row.suffix,
  texts: row.name === 'Mew ex'
    ? cardTexts(null, [{ name: 'Genome Hacking', effect: "Choose 1 of your opponent's Active Pokemon's attacks and use it as this attack." }], null)
    : [],
}))
const lookupIndex = buildLookupIndex(lookupRows, fixture.lookup_set_codes)

describe('lookup', () => {
  it('number pairs', () => {
    for (const item of fixture.number_pairs) {
      expect(numberPairs(item.input.lines, item.input.number, item.input.total)).toEqual(item.output)
    }
  })
  it('search trace', () => {
    for (const item of fixture.lookup_search) {
      const evidence = searchLookup(lookupIndex, item.input.lines, item.input.number, item.input.total, item.input.tokens)
      expect(evidenceTrace(evidence)).toEqual(item.output)
    }
  })
})

describe('decide', () => {
  fixture.decide.forEach((item, position) => {
    it(`case ${position}`, () => {
      const options = { fallback: item.input.options.fallback ?? false, numberRead: item.input.options.number_read ?? true }
      const [chosen, reason] = decide({ ...item.input.card_info }, item.input.candidates.map(card => ({ ...card })), options)
      expect({ mechanism: chosen ? chosen.mechanism : null, tcg_card_id: chosen ? chosen.candidate.tcg_card_id ?? null : null, reason }).toEqual(item.output)
    })
  })
})

describe('thresholds', () => {
  it('the defaults are the manifest values of matcher version 11', () => {
    for (const [key, value] of Object.entries(fixture.thresholds)) expect(DEFAULT_THRESHOLDS[key], key).toBe(value)
  })
  it('a manifest overrides the defaults', () => {
    expect(thresholdsFromManifest({ thresholds: { sim_min_with_rules: 0.6, bogus: 1, top_k: 'x' } })).toMatchObject({ sim_min_with_rules: 0.6, top_k: 20 })
  })
})
