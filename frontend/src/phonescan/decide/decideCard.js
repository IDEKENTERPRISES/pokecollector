// The phone's version of the tail of CardMatcher.match(): from the picture scores and what the text reader read, to
// the merged candidate list and the decision. Everything before it (the card finder, the model, the picture search,
// the reading) belongs to the other two folders and to the integration step; everything after it is this file's
// answer. The order of the steps is CardMatcher.match()'s:
//
//   top K of the picture scores -> lookup evidence (number / set code / text) -> merge with the name search
//   -> build candidates (rank, similarity, lane facts) -> card_info -> number_from_lookup -> correct_number -> decide
//
// Pure: plain data in, plain data out.

import { evidenceLevelOf, evidenceEmpty, evidenceTrace, evidenceUniqueAtOrAbove, searchLookup } from './lookup.js'
import { nameScoreOf, scoreNames } from './names.js'
import { correctNumber, decide, mergeCandidates, numberFromLookup } from './pipeline.js'
import { pyRound } from './pyCompat.js'
import { resolveThresholds } from './thresholds.js'

/**
 * The picture side as the server holds it after ``_picture_scores``: ``{ids, scores, art}``. ``ids`` are the card ids of
 * the index rows; ``scores[row]`` is every card's picture score (the average over the whole-card and artwork signals
 * when both exist), ``art[row]`` the artwork-only similarity (or null). Float32Array, Float64Array or plain arrays.
 *
 * ``pictureTopK`` (``{whole: [{id, score}], art: [{id, score}]}``) is the short form for callers that only kept the two
 * top lists. It is an approximation: a card in one list only is scored by that signal alone, a card in neither is unknown
 * (so a text candidate outside both lists cannot be ranked), and a picture rank is the position in the union. Use
 * ``pictureScores`` whenever the full score vectors are at hand (they are: the phone computes every dot product).
 */
export function scoresFromTopK(pictureTopK) {
  const whole = new Map((pictureTopK?.whole ?? []).map(item => [item.id, item.score]))
  const art = new Map((pictureTopK?.art ?? []).map(item => [item.id, item.score]))
  const ids = [...new Set([...whole.keys(), ...art.keys()])]
  const scores = ids.map(id => {
    const w = whole.get(id)
    const a = art.get(id)
    if (w !== undefined && a !== undefined) return (w + a) / 2
    return w !== undefined ? w : a
  })
  const artScores = art.size ? ids.map(id => (art.has(id) ? art.get(id) : null)) : null
  return { ids, scores, art: artScores }
}

function topHits(scores, ids, topK) {
  const count = scores.length
  const k = Math.min(topK, count)
  const order = Array.from({ length: count }, (_, row) => row).sort((a, b) => (scores[b] - scores[a]) || (a - b))
  return order.slice(0, k).map(row => [ids[row], Number(scores[row])])
}

const countAbove = (scores, score) => {
  let above = 0
  for (let row = 0; row < scores.length; row += 1) if (scores[row] > score) above += 1
  return above
}

function cardInfoFrom(read, candidates) {
  if (!read) return {}
  const known = new Set(candidates.map(card => card.set_abbreviation).filter(Boolean).map(code => String(code).toUpperCase()))
  const tokens = read.tokens ?? (read.setCode ? [read.setCode] : [])
  const setCode = known.size ? (tokens.find(token => known.has(token)) ?? null) : null
  return {
    number_local: read.number ?? null,
    number_total: read.total ?? null,
    set_code: setCode,
    hp: read.hp ?? null,
    language: null, // English-only catalogue: the language is not evidence
  }
}

/**
 * decideCard({pictureScores | pictureTopK, read, options, indexes, thresholds}) ->
 *   {decided, cardId, tcgCardId, mechanism, reason, similarity, lead,
 *    candidates: [{id, tcgCardId, score, rank, pictureRank, name, number, set, printedTotal, evidence}],
 *    corrected, numberFromLookup, ...the server's MatchResult fields: status, decision, unsure_reason, matches, ocr}
 *
 * ``read``: {number, total, setCode, tokens, hp, lines, bodyLines, name, nameLines, numberSource, numberConfidence}
 * (``name`` undefined means the name was not read at all; null means it was read and nothing came out). ``null`` is a scan
 * with no text reading (``use_ocr`` off): the picture alone decides.
 * ``options``: {numberOnce, wholeStrict, reprint, fallback, useNames, useNumber, useText, topK}; ``fallback`` is the server's
 * ``fallback is not None and not trusted``: the card was not found by the finder, so only a number read from it may decide.
 */
export function decideCard({ pictureScores = null, pictureTopK = null, read = null, options = {}, indexes, thresholds = null }) {
  const t = resolveThresholds(thresholds)
  const picture = pictureScores ?? scoresFromTopK(pictureTopK)
  const { ids, scores } = picture
  const art = picture.art ?? null
  const rowOf = picture.rowOf ?? new Map(ids.map((id, row) => [id, row])) // a caller that scores every card on every photo passes its own map (no 19.7k-entry map per photo)
  const topK = options.topK ?? t.top_k
  const count = scores.length
  let hits = topHits(scores, ids, topK)

  const names = options.useNames === false ? null : (indexes.names ?? null)
  const lookup = indexes.lookup ?? null
  const useNumber = Boolean(lookup) && options.useNumber !== false
  const useText = Boolean(lookup) && options.useText !== false
  const nameRead = read !== null && read.name !== undefined && names !== null
  let evidence = null
  let added = 0
  const ocr = {}

  if (read) {
    if (useNumber || useText) {
      const body = [...(read.lines ?? []), ...(read.bodyLines ?? [])].filter(Boolean)
      evidence = searchLookup(lookup, body, read.number ?? null, read.total ?? null, read.tokens ?? (read.setCode ? [read.setCode] : []), { number: useNumber, text: useText })
      if (!evidenceEmpty(evidence)) ocr.lookup = evidenceTrace(evidence)
    }
    if (nameRead || evidence !== null) {
      ;[hits, added] = mergeCandidates({
        hits, scores, rowOf, names, name: read.name ?? null, number: read.number ?? null, total: read.total ?? null, topK,
        evidence, numberOnce: Boolean(options.numberOnce),
      }, t)
      ocr.text_candidates_added = added
    }
  }

  const nameKnown = Boolean(nameRead && read.name && names && scoreNames(names, read.name).length)
  const candidates = []
  hits.forEach(([cardId, score], offset) => {
    const row = indexes.candidates.get(cardId)
    if (!row) return
    const position = offset + 1
    const candidate = { ...row, _db_id: cardId, _similarity: pyRound(score, 4), _rank: count ? 1 + countAbove(scores, score) : position, _position: position }
    if (nameRead && names) {
      candidate._name_score = pyRound(nameScoreOf(names, cardId, read.name), 3)
      candidate._name_known = nameKnown
    }
    if (evidence !== null) {
      const level = evidenceLevelOf(evidence, cardId)
      if (level) {
        candidate._lookup = level
        candidate._lookup_unique = evidenceUniqueAtOrAbove(evidence, level) === 1
      }
      const textHit = evidence.text.get(cardId)
      if (textHit) {
        candidate._text_score = pyRound(textHit.score, 3)
        candidate._text_cards = textHit.cards
      }
    }
    const artRow = rowOf.get(cardId)
    if (art && artRow !== undefined && art[artRow] !== null && art[artRow] !== undefined) candidate._art_similarity = pyRound(art[artRow], 4)
    candidates.push(candidate)
  })

  const cardInfo = cardInfoFrom(read, candidates)
  const lookedUp = evidence !== null ? numberFromLookup(cardInfo, candidates) : null
  if (lookedUp) ocr.number_from_lookup = lookedUp
  const corrected = correctNumber(cardInfo, candidates, read?.lines ?? [])
  if (corrected) ocr.corrected = corrected
  const numberSource = read?.number ? (read.numberSource ?? 'finder_card') : (read?.numberSource ?? null)
  const [chosen, reason] = decide(cardInfo, candidates, {
    reprint: Boolean(options.reprint), fallback: Boolean(options.fallback), numberRead: Boolean(read?.number && !lookedUp),
    wholeStrict: Boolean(options.wholeStrict), numberSource, numberConfidence: read?.numberConfidence ?? null,
  }, t)

  const matches = candidates.map(card => {
    const match = {
      card_id: card._db_id, tcg_card_id: card.tcg_card_id, similarity: card._similarity, rank: card._position, name: card.name ?? null,
      number: card.number ?? null, set: card.set ?? null, printed_total: card.printed_total ?? null, picture_rank: card._rank,
    }
    if ('_name_score' in card) match.name_score = card._name_score
    if (card._lookup) match.lookup = card._lookup
    if ('_text_score' in card) match.text_score = card._text_score
    if ('_art_similarity' in card) match.art_similarity = card._art_similarity
    return match
  })
  let decision = null
  if (chosen) {
    const winner = chosen.candidate
    decision = { card_id: winner._db_id, tcg_card_id: winner.tcg_card_id, mechanism: chosen.mechanism, similarity: winner._similarity, lead: chosen.lead }
  }
  return {
    decided: decision !== null,
    cardId: decision ? decision.card_id : null,
    tcgCardId: decision ? decision.tcg_card_id : null,
    mechanism: decision ? decision.mechanism : null,
    reason: decision ? null : reason,
    similarity: decision ? decision.similarity : null,
    lead: decision ? decision.lead : null,
    candidates: candidates.map(card => ({
      id: card._db_id, tcgCardId: card.tcg_card_id, score: card._similarity, rank: card._position, pictureRank: card._rank,
      name: card.name ?? null, number: card.number ?? null, set: card.set ?? null, printedTotal: card.printed_total ?? null,
      evidence: {
        nameScore: card._name_score ?? null, nameKnown: card._name_known ?? null, lookup: card._lookup ?? null, lookupUnique: card._lookup_unique ?? null,
        textScore: card._text_score ?? null, textCards: card._text_cards ?? null, artSimilarity: card._art_similarity ?? null,
      },
    })),
    corrected: corrected ?? null,
    numberFromLookup: lookedUp ?? null,
    // the server's MatchResult fields, same names
    status: decision ? 'decided' : 'unsure',
    decision,
    unsure_reason: decision ? null : reason,
    matches,
    ocr,
    cardInfo,
  }
}
