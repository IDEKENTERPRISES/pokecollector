// Port of the deciding half of backend/services/card_match/pipeline.py (matcher version 11): merging the
// picture top list with the text candidates, the decision lanes, the checks that hold for every lane, the
// number corrections and the strict rule for a number read only from the whole picture.
//
// A *candidate* is the dict the server's ranking rules read (``number``, ``printed_total``, ``name``,
// ``set_abbreviation`` ...) plus the picture facts ``_similarity``, ``_rank`` (1 = closest picture) and the
// lane facts ``_name_score``, ``_name_known``, ``_lookup``, ``_lookup_unique``, ``_text_score``,
// ``_text_cards``, ``_art_similarity``. Everything is plain data; nothing here touches IndexedDB or the DOM.

import { constrain } from './constrained.js'
import {
  evidenceAddIds, evidenceBonus, evidenceEmpty, evidenceNumberBonus,
} from './lookup.js'
import { agreement, nameKey, nameScoreOf, searchNames } from './names.js'
import { compareTuples, pyRound } from './pyCompat.js'
import { candidateRankKey, metadataDecision, numbersMatch, printedTotalSignal } from './rules.js'
import { DEFAULT_THRESHOLDS } from './thresholds.js'

export const SOURCE_WHOLE_PICTURE = 'whole_picture'

// ── small checks ─────────────────────────────────────────────────────────────

/** A printing found by its printed number may sit far down the picture ranking only with a unique number + total match and a picture that still agrees. */
export function lookupNear(card, t = DEFAULT_THRESHOLDS) {
  const level = card._lookup
  if (!card._lookup_unique) return false
  if (level === 'number_total_set') return card._rank <= t.lookup_rank_max && card._similarity >= t.lookup_sim_set
  if (level === 'number_total') return card._rank <= t.lookup_rank_max_total && card._similarity >= t.lookup_sim_total
  return false
}

/** A name was read that is in the catalogue, and it is not this card's name. */
export function nameConflict(card) {
  return Boolean(card._name_known) && (card._name_score ?? 0.0) <= 0.0
}

/** Several printings of one name look alike: take the one whose artwork-only similarity is clearly highest. Never guesses. */
export function reprintChoice(candidates, t = DEFAULT_THRESHOLDS) {
  const ranked = [...candidates].sort((a, b) => a._rank - b._rank)
  if (ranked.length < 2 || ranked[0]._similarity < t.sim_min_picture_only) return null
  const key = nameKey(ranked[0].name || '')
  const group = ranked.filter(card => nameKey(card.name || '') === key)
  if (!key || group.length < 2 || group.some(card => card._art_similarity === undefined || card._art_similarity === null)) return null
  const others = ranked.filter(card => !group.includes(card))
  if (others.length && group[0]._similarity - others[0]._similarity < t.lead_min_picture_only) return null
  const byArt = [...group].sort((a, b) => b._art_similarity - a._art_similarity)
  const lead = byArt[0]._art_similarity - byArt[1]._art_similarity
  const winner = byArt[0]
  if (lead < t.reprint_art_lead || winner._similarity < t.sim_min_picture_only || winner._rank > 5) return null
  return { candidate: winner, mechanism: 'reprint_art_lead', lead: pyRound(lead, 4) }
}

/** A total was read, the card prints one, and they are different numbers ("086" against 114). */
export function totalContradiction(cardInfo, card) {
  return printedTotalSignal(cardInfo.number_total, card.printed_total) === 2
}

/** Another printing of the chosen card's name whose picture is closer by more than ``same_name_picture_margin``. */
export function closerSameName(chosen, candidates, t = DEFAULT_THRESHOLDS) {
  const key = nameKey(chosen.name || '')
  if (!key) return null
  const rivals = candidates.filter(card => card !== chosen && nameKey(card.name || '') === key
    && card._similarity - chosen._similarity > t.same_name_picture_margin)
  if (!rivals.length) return null
  return rivals.reduce((best, card) => (card._similarity > best._similarity ? card : best))
}

/** Version 10 (``wholestrict``): why a decision resting on a number read only from the whole picture is refused, or null. */
export function wholeNumberProblem(cardInfo, chosen, { numberSource = null, numberConfidence = null } = {}, t = DEFAULT_THRESHOLDS) {
  if (numberSource !== SOURCE_WHOLE_PICTURE) return null
  const candidate = chosen.candidate
  if (chosen.mechanism === 'picture_lead_strong') return null
  if (!cardInfo.number_total || printedTotalSignal(cardInfo.number_total, candidate.printed_total) !== 0) return 'whole_number_total_not_confirmed'
  if (candidate._rank > t.whole_pick_rank_max || candidate._similarity < t.sim_min_with_rules + t.whole_sim_margin) return 'whole_number_picture_too_weak'
  if (nameConflict(candidate)) return 'whole_number_name_conflict'
  if (numberConfidence === null || numberConfidence === undefined || numberConfidence < t.ocr_accept_confidence) return 'whole_number_low_confidence'
  return null
}

// ── the decision ─────────────────────────────────────────────────────────────

/** [chosen candidate + mechanism + lead, or null; reason or null] from OCR'd identifiers and picture scores. */
export function decideLanes(cardInfo, candidates, { reprint = false, fallback = false, numberRead = true } = {}, t = DEFAULT_THRESHOLDS) {
  if (!candidates.length) return [null, 'no_picture_matches']
  if (fallback && !(numberRead && cardInfo.number_local)) return [null, 'card_not_found_no_number_read']
  const bySimilarity = [...candidates].sort((a, b) => a._rank - b._rank)
  const topPicture = bySimilarity[0]
  const lead = topPicture._similarity - (bySimilarity.length > 1 ? bySimilarity[1]._similarity : 0.0)
  if (cardInfo.number_local) {
    const numberHits = candidates.filter(card => numbersMatch(cardInfo.number_local, card.number))
    const [decided, mechanism] = metadataDecision(cardInfo, candidates)
    if (decided) {
      const chosen = candidates.map(card => ({ card, key: candidateRankKey(cardInfo, card) }))
        .reduce((best, item) => (compareTuples(item.key, best.key) < 0 ? item : best)).card
      const near = chosen._rank <= t.rank_max_with_rules || ((chosen._name_score ?? 0.0) >= 0.9 && chosen._rank <= t.rank_max_with_name)
      if (chosen._lookup && nameConflict(chosen)) return [null, 'number_lookup_conflicts_with_name']
      if (totalContradiction(cardInfo, chosen)) return [null, 'total_contradicts_read']
      if (closerSameName(chosen, candidates, t) !== null) return [null, 'closer_printing_of_same_name']
      if (chosen._similarity >= t.sim_min_with_rules && (near || lookupNear(chosen, t))) {
        return [{ candidate: chosen, mechanism, lead: pyRound(lead, 4) }, null]
      }
      return [null, 'rules_choice_not_close_in_picture']
    }
    if (!numberHits.length) {
      if (!fallback && topPicture._similarity >= t.sim_min_picture_strong && lead >= t.lead_min_picture_strong) {
        return [{ candidate: topPicture, mechanism: 'picture_lead_strong', lead: pyRound(lead, 4) }, null]
      }
      return [null, 'number_not_among_picture_matches']
    }
    // The number matches several printings: the picture breaks the tie only when it is clear.
    if (numberHits.length > 1) {
      numberHits.sort((a, b) => a._rank - b._rank)
      const gap = numberHits[0]._similarity - numberHits[1]._similarity
      if (gap >= t.lead_min_picture_only && numberHits[0]._similarity >= t.sim_min_with_rules) {
        const pick = numberHits[0]
        if (totalContradiction(cardInfo, pick)) return [null, 'total_contradicts_read']
        if (closerSameName(pick, candidates, t) !== null) return [null, 'closer_printing_of_same_name']
        return [{ candidate: pick, mechanism: 'number_and_picture', lead: pyRound(gap, 4) }, null]
      }
    }
    if (reprint && !fallback) {
      const found = reprintChoice(candidates, t)
      if (found) return [found, null]
    }
    return [null, 'number_matches_several_printings']
  }
  if (topPicture._similarity >= t.sim_min_picture_only && lead >= t.lead_min_picture_only) {
    return [{ candidate: topPicture, mechanism: 'picture_lead', lead: pyRound(lead, 4) }, null]
  }
  if ((topPicture._name_score ?? 0.0) >= t.name_agrees && topPicture._similarity >= t.sim_min_name_picture && lead >= t.lead_min_name_picture) {
    return [{ candidate: topPicture, mechanism: 'name_and_picture', lead: pyRound(lead, 4) }, null]
  }
  if ((topPicture._text_score ?? 0.0) >= t.text_agrees && (topPicture._text_cards ?? 99) <= t.text_max_cards
      && !nameConflict(topPicture)
      && topPicture._similarity >= t.sim_min_name_picture && lead >= t.lead_min_name_picture) {
    return [{ candidate: topPicture, mechanism: 'text_and_picture', lead: pyRound(lead, 4) }, null]
  }
  if (reprint) {
    const found = reprintChoice(candidates, t)
    if (found) return [found, null]
  }
  return [null, 'no_number_and_picture_not_clear']
}

/** ``decideLanes``, then the checks that hold for every lane. Returns [chosen | null, reason | null]. */
export function decide(cardInfo, candidates, options = {}, t = DEFAULT_THRESHOLDS) {
  const { reprint = false, fallback = false, numberRead = true, wholeStrict = false, numberSource = null, numberConfidence = null } = options
  const [chosen, reason] = decideLanes(cardInfo, candidates, { reprint, fallback, numberRead }, t)
  if (chosen !== null && totalContradiction(cardInfo, chosen.candidate)) return [null, 'total_contradicts_read']
  if (chosen !== null && wholeStrict) {
    const problem = wholeNumberProblem(cardInfo, chosen, { numberSource, numberConfidence }, t)
    if (problem) return [null, problem]
  }
  return [chosen, reason]
}

/**
 * OCR's number parse can be fooled by the text beside the number ("30C | 017/128"). When it names none of the
 * candidates but the number lookup found a printing by number and total, read that printing's number and total
 * instead. Changes ``cardInfo`` in place; returns what changed, or null.
 */
export function numberFromLookup(cardInfo, candidates) {
  const read = cardInfo.number_local
  if (read && candidates.some(card => numbersMatch(read, card.number))) return null
  const order = ['number_total_set', 'number_total']
  const found = candidates.filter(card => order.includes(card._lookup))
  if (!found.length) return null
  found.sort((a, b) => (order.indexOf(a._lookup) - order.indexOf(b._lookup)) || (b._similarity - a._similarity))
  const best = found[0]
  cardInfo.number_local = best.number
  if (best.printed_total) cardInfo.number_total = String(best.printed_total)
  return { read: read ?? null, number: best.number, total: cardInfo.number_total ?? null, level: best._lookup }
}

/**
 * The number OCR read names none of the closest printings (or none was read): look for the one printing whose
 * "number/total" the recognised text is a damaged copy of, and read that number instead. In place; returns the change or null.
 */
export function correctNumber(cardInfo, candidates, lines) {
  if (!candidates.length || !lines.length) return null
  const read = cardInfo.number_local
  if (read && candidates.some(card => numbersMatch(read, card.number))) return null
  const found = constrain(lines, candidates)
  if (found === null) return null
  cardInfo.number_local = found.number
  cardInfo.number_total = found.total
  return { read: read ?? null, number: found.number, total: found.total, distance: found.distance }
}

// ── merging the picture list with the text candidates ───────────────────────

/**
 * The picture top list and the text candidates as one ranking of at most ``topK`` printings.
 * ``hits``: [[card id, picture similarity]], best first. ``scores``: every indexed card's picture score (array,
 * indexed by row), ``rowOf``: Map card id -> row. ``names``: a name index (or null). Returns [[id, picture
 * similarity] ..., how many came from the text search only].
 */
export function mergeCandidates({
  hits, scores, rowOf, names = null, name = null, number = null, total = null, topK = DEFAULT_THRESHOLDS.top_k, evidence = null, numberOnce = false,
}, t = DEFAULT_THRESHOLDS) {
  const useNames = names !== null && Boolean(name)
  const useLookup = evidence !== null && !evidenceEmpty(evidence)
  if (!useNames && !useLookup) return [hits, 0]
  const pictureIds = hits.map(hit => hit[0])
  const pool = new Map(hits.map(hit => [hit[0], hit[1]]))
  const found = useNames ? searchNames(names, name, number, total) : []
  if (useLookup) {
    for (const cardId of evidenceAddIds(evidence)) {
      const row = rowOf.get(cardId)
      if (row !== undefined && !pool.has(cardId)) pool.set(cardId, Number(scores[row]))
    }
  }
  for (const hit of found) {
    const row = rowOf.get(hit.card_id)
    if (row !== undefined && !pool.has(hit.card_id)) pool.set(hit.card_id, Number(scores[row]))
  }

  const memo = new Map()
  const combined = cardId => {
    if (memo.has(cardId)) return memo.get(cardId)
    let bonus = 0.0
    let readNumber = 0.0
    if (useNames) {
      const nameScore = nameScoreOf(names, cardId, name)
      const agree = agreement(names, cardId, nameScore, number, total)
      bonus = t.name_weight * Math.max(0.0, (nameScore - 0.72) / 0.28)
      readNumber = (agree.number_ok ? t.number_weight : 0.0) + (agree.total_ok ? t.total_weight : 0.0)
    }
    if (useLookup) {
      if (numberOnce) {
        readNumber = Math.max(readNumber, evidenceNumberBonus(evidence, cardId))
        bonus += evidenceBonus(evidence, cardId, { number: false })
      } else {
        bonus += evidenceBonus(evidence, cardId)
      }
    }
    const value = pool.get(cardId) + bonus + readNumber
    memo.set(cardId, value)
    return value
  }

  const keep = pictureIds.slice(0, Math.min(t.picture_keep, topK))
  const keepSet = new Set(keep)
  const rest = [...pool.keys()].filter(cardId => !keepSet.has(cardId))
    .map((cardId, position) => ({ cardId, position, value: combined(cardId) }))
    .sort((a, b) => (b.value - a.value) || (a.position - b.position))
    .map(item => item.cardId)
  const chosen = [...keep, ...rest.slice(0, Math.max(0, topK - keep.length))]
    .map((cardId, position) => ({ cardId, position, value: combined(cardId) }))
    .sort((a, b) => (b.value - a.value) || (a.position - b.position))
    .map(item => item.cardId)
  const original = new Set(pictureIds)
  return [chosen.map(cardId => [cardId, pool.get(cardId)]), chosen.filter(cardId => !original.has(cardId)).length]
}
