// Parity with the Python matcher on many `decide` inputs (tests/fixtures/phone-matcher/v11/decide/, written by
// backend/scripts/phone_parity_decide.py from hand-written rows and seeded random scores). The decision, the card, the
// mechanism, the reason and the candidate order must match exactly; scores within floating-point tolerance.
import { describe, expect, it } from 'vitest'
import catalogue from '../../../tests/fixtures/phone-matcher/v11/decide/catalogue.json'
import fixture from '../../../tests/fixtures/phone-matcher/v11/decide/cases.json'
import { buildDecideIndexes, decideCard } from './index.js'

const indexes = buildDecideIndexes(catalogue.rows)
const TOLERANCE = 1e-9

const sameNumber = (actual, expected, where) => {
  if (expected === null || expected === undefined) {
    expect(actual ?? null, where).toBeNull()
  } else {
    expect(Math.abs(actual - expected), `${where}: ${actual} vs ${expected}`).toBeLessThanOrEqual(TOLERANCE)
  }
}

describe('catalogue adapter', () => {
  it('keeps exactly the cards the server indexes (English, physical, with a picture and a name)', () => {
    const kept = catalogue.ids.filter(id => !id.startsWith('ghost-'))
    expect([...indexes.candidates.keys()].sort()).toEqual([...kept].sort())
    expect(indexes.stats.skipped).toBe(catalogue.rows.length - kept.length)
    expect(indexes.names.rows.size).toBe(kept.length)
    expect(indexes.lookup.rows.size).toBe(kept.length)
  })
})

describe('decideCard against the Python matcher', () => {
  const cases = fixture.cases
  const seen = { mechanisms: new Set(), reasons: new Set() }

  cases.forEach(item => {
    it(item.label, () => {
      const result = decideCard({
        pictureScores: { ids: catalogue.ids, scores: item.scores, art: item.art },
        read: item.read,
        options: item.options,
        indexes,
      })
      const expected = item.python
      expect(result.decided, 'decided').toBe(expected.decided)
      expect(result.cardId).toBe(expected.decision ? expected.decision.card_id : null)
      expect(result.mechanism).toBe(expected.decision ? expected.decision.mechanism : null)
      expect(result.reason).toBe(expected.reason)
      if (expected.decision) {
        sameNumber(result.similarity, expected.decision.similarity, 'similarity')
        sameNumber(result.lead, expected.decision.lead, 'lead')
      }
      expect(result.matches.map(match => match.card_id), 'candidate order').toEqual(expected.matches.map(match => match.card_id))
      result.matches.forEach((match, position) => {
        const want = expected.matches[position]
        const where = `${want.card_id}`
        sameNumber(match.similarity, want.similarity, `${where} similarity`)
        expect(match.rank, `${where} rank`).toBe(want.rank)
        expect(match.picture_rank, `${where} picture rank`).toBe(want.picture_rank)
        expect(match.name).toBe(want.name)
        expect(match.number).toBe(want.number)
        expect(match.printed_total ?? null).toBe(want.printed_total ?? null)
        sameNumber(match.name_score, want.name_score, `${where} name score`)
        sameNumber(match.text_score, want.text_score, `${where} text score`)
        sameNumber(match.art_similarity, want.art_similarity, `${where} art`)
        expect(match.lookup ?? null).toBe(want.lookup ?? null)
        const candidate = result.candidates[position]
        expect(candidate.evidence.lookupUnique ?? null, `${where} lookup unique`).toBe(want.lookup_unique ?? null)
        expect(candidate.evidence.nameKnown ?? null, `${where} name known`).toBe(want.name_known ?? null)
        expect(candidate.evidence.textCards ?? null, `${where} text cards`).toBe(want.text_cards ?? null)
      })
      expect(result.ocr.text_candidates_added).toBe(expected.ocr.text_candidates_added)
      expect(result.ocr.lookup).toEqual(expected.ocr.lookup)
      expect(result.ocr.number_from_lookup).toEqual(expected.ocr.number_from_lookup)
      if (expected.ocr.corrected) {
        expect({ ...result.ocr.corrected, distance: 0 }).toEqual({ ...expected.ocr.corrected, distance: 0 })
        sameNumber(result.ocr.corrected.distance, expected.ocr.corrected.distance, 'corrected distance')
      } else {
        expect(result.ocr.corrected).toBeUndefined()
      }
      expect({ ...result.cardInfo, language: undefined }).toEqual({ ...expected.card_info, language: undefined })
      if (expected.decision) seen.mechanisms.add(expected.decision.mechanism)
      else seen.reasons.add(expected.reason)
    })
  })

  it('covers every mechanism and refusal reason that can be reached', () => {
    const mechanisms = new Set(cases.filter(item => item.python.decision).map(item => item.python.decision.mechanism))
    const reasons = new Set(cases.filter(item => !item.python.decision).map(item => item.python.reason))
    // artist_hp needs card_info.artist, which the text reader never fills: unreachable, in Python as well.
    expect([...mechanisms].sort()).toEqual([
      'name_and_picture', 'number_and_picture', 'number_metadata', 'number_unique', 'picture_lead', 'picture_lead_strong', 'reprint_art_lead', 'text_and_picture',
    ])
    expect([...reasons].sort()).toEqual([
      'card_not_found_no_number_read', 'closer_printing_of_same_name', 'no_number_and_picture_not_clear', 'no_picture_matches',
      'number_lookup_conflicts_with_name', 'number_matches_several_printings', 'number_not_among_picture_matches', 'rules_choice_not_close_in_picture',
      'total_contradicts_read', 'whole_number_low_confidence', 'whole_number_name_conflict', 'whole_number_picture_too_weak', 'whole_number_total_not_confirmed',
    ])
  })
})
