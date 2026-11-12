// Parity of the small helpers under the matcher (difflib, text and name normalising, number keys, rounding) with Python,
// from tests/fixtures/phone-matcher/v11/decide/strings.json (backend/scripts/phone_parity_decide.py).
import { describe, expect, it } from 'vitest'
import fixture from '../../../tests/fixtures/phone-matcher/v11/decide/strings.json'
import { SequenceMatcher } from './difflib.js'
import { normText, numberKey, totalKey } from './lookup.js'
import { baseKey, buildNameIndex, nameKey, nameScoreOf, scoreNames } from './names.js'
import { pyRound } from './pyCompat.js'
import { normalizeNumber, normalizePrintedTotal, numbersMatch, printedTotalSignal, scannerNamesCompatible } from './rules.js'

describe('SequenceMatcher (autojunk off)', () => {
  it('ratios and merged matching blocks equal Python for every pair', () => {
    for (const item of fixture.ratios) {
      const matcher = new SequenceMatcher(item.a, item.b)
      const where = JSON.stringify([item.a, item.b])
      expect(matcher.ratio(), where).toBe(item.ratio)
      expect(matcher.quickRatio(), where).toBe(item.quick)
      expect(matcher.realQuickRatio(), where).toBe(item.real_quick)
      expect(matcher.getMatchingBlocks().map(block => [block.a, block.b, block.size]), where).toEqual(item.blocks)
    }
  })
})

describe('pyRound', () => {
  it('rounds half to even on the exact value like Python', () => {
    for (const item of fixture.round) expect(pyRound(item.value, item.digits), `${item.value} ${item.digits}`).toBe(item.rounded)
  })
})

describe('normalising', () => {
  it('norm_text', () => {
    for (const item of fixture.norm_text) expect(normText(item.input), JSON.stringify(item.input)).toBe(item.output)
  })
  it('name keys and compatibility', () => {
    for (const item of fixture.names) {
      expect(nameKey(item.input), item.input).toBe(item.key)
      expect(baseKey(item.input), item.input).toBe(item.base_key)
      for (const [other, expected] of Object.entries(item.compatible_with)) expect(scannerNamesCompatible(item.input, other), `${item.input} / ${other}`).toBe(expected)
    }
  })
  it('numbers and totals', () => {
    for (const item of fixture.numbers) {
      const where = JSON.stringify(item.input)
      expect(normalizeNumber(item.input), where).toBe(item.normalized)
      expect(normalizePrintedTotal(item.input), where).toBe(item.total)
      expect(numberKey(item.input), where).toBe(item.number_key)
      expect(totalKey(item.input), where).toBe(item.total_key)
      for (const [other, expected] of Object.entries(item.matches)) expect(numbersMatch(item.input, other), `${where} ${other}`).toBe(expected)
      for (const [other, expected] of Object.entries(item.signal)) expect(printedTotalSignal(item.input, other === 'None' ? null : other), `${where} ${other}`).toBe(expected)
    }
  })
})

describe('name scores', () => {
  const rows = ['Pikachu', 'Pikachu V', 'Mew ex', 'Ho-Oh', 'Charizard ex', 'Lapras', 'Lapras GX', 'Flabébé'].map((name, index) => ({ card_id: `c${index}`, name, number: '1', printed_total: '10' }))
  const index = buildNameIndex(rows)
  it('every card score and the close-name list equal Python', () => {
    for (const item of fixture.name_score) {
      expect(rows.map(row => [row.card_id, pyRound(nameScoreOf(index, row.card_id, item.read), 6)]), item.read).toEqual(item.scores)
      expect(scoreNames(index, item.read).map(([score, key]) => [pyRound(score, 6), key]), item.read).toEqual(item.names)
    }
  })
})
