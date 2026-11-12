// The phone's picture matcher: CardMatcher.match (backend/services/card_match/pipeline.py, matcher version 11) for the kept option set
//   names+number+text+art+tta+fastread+numberonce+corners+wholepic+wholeread+wholestrict   (no reprint, no trustrejected),
// joined from the three ports of step 3: the finder (3a), the reader (3b) and the decision (3c).
//
// The order and the branches are the server's:
//   1. find the card (corners, a refused quad -> the whole picture)               [finder]
//   2. embed the card upright and turned 180, search the whole-card index; the turned view must beat the upright one by
//      ORIENT_MARGIN to count as "turned"                                          [views, embed, search]
//   3. views of the oriented card (tight, CLAHE) and the artwork windows of the oriented card and of both; embed; search the
//      whole-card index again (best over all views) and the artwork index; score = (whole + art) / 2   [views, embed, search]
//   4. read the text the right way up: when the picture said turned, turned only; otherwise upright first and, when that gave
//      nothing usable (and the card was FOUND), turned too, keeping the better read. The first read holds back its last-resort
//      band when a second read applies                                                [ocr_number, name]
//   5. `wholeread`: a card the finder cut out of a guide picture, whose number is not complete: read the whole picture once more
//      (then the last-resort band the first read held back)                           [second_read]
//   6. when the text turned the card, the picture scores are made again for the real orientation  [views, embed, search]
//   7. `decideCard` with every card's picture score, the read and the option set      [decide]
//
// Everything outside it is passed in (`deps`): the embedder, the index, the reader's ORT sessions and the catalogue indexes, so the
// unit tests run the whole flow with stubs and recorded values. The photo is {data: RGBA, width, height}.
import { artCrop as defaultArtCrop, augmentedViews as defaultAugmentedViews, findCard as defaultFindCard, isGuidePicture as defaultIsGuide, rotate180 as defaultRotate180, wholeCard as defaultWholeCard } from '../finder'
import { readCard as defaultReadCard, readName as defaultReadName, secondRead as defaultSecondRead, SOURCE_FINDER_CARD } from '../ocr'
import { completeness, isComplete } from '../ocr/parse'
import { decideCard as defaultDecideCard } from '../decide/decideCard'
import { scoreNames as defaultScoreNames } from '../decide/names'
import { resolveThresholds } from '../decide/thresholds'
import { combineScores, maxInto, searchArt, searchWhole } from './pictureIndex'
import { MATCHER_VERSION } from './guard'

export { MATCHER_VERSION }

/** Seconds. The server's FAST_BUDGET_SECONDS is 0.9 for each ladder; the phone starts with the same numbers (docs/phone-scanner/ocr.md). */
export const DEFAULT_BUDGETS = Object.freeze({ number: 0.9, name: 0.9, secondRead: 0.9 })

/** The in-use + wholeread + wholestrict option set as `decideCard` options (the server's kept set). */
export const KEPT_OPTIONS = Object.freeze({ numberOnce: true, wholeStrict: true, reprint: false, useNames: true, useNumber: true, useText: true })

export const STAGES = ['finder', 'views', 'embed', 'search', 'ocr_number', 'name', 'second_read', 'decide']

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function timer(now) {
  const timings = Object.fromEntries(STAGES.map(stage => [stage, 0]))
  const trace = []
  return {
    timings,
    trace,
    async run(stage, fn) {
      const began = now()
      try {
        return await fn()
      } finally {
        timings[stage] += now() - began
        trace.push(stage)
      }
    },
  }
}

const roundMs = value => Math.round(value * 10) / 10

/** Picks the better reading of a card read upright and read turned: (completeness, name found) compared as the server does. */
const usable = (read, nameRead, names, scoreNames) => [
  completeness(read),
  nameRead && nameRead.name && names && scoreNames(names, nameRead.name).length ? 1 : 0,
]
const anyUsable = pair => pair[0] > 0 || pair[1] > 0
const better = (a, b) => (a[0] !== b[0] ? a[0] > b[0] : a[1] > b[1])

/**
 * createPhoneMatcher(deps) -> {match(photo, options)}.
 *
 * deps:
 *   embedder      {embed(images) -> Promise<Float32Array[]> (unit vectors, one per image, in order), backend: string}
 *   index         buildPictureIndex(...) result
 *   sessions      the reader's {detect, recognise, characters} (null: no text reading, picture only)
 *   getDecideIndexes   async () -> catalogue indexes (buildDecideIndexes result) or null when the card database is not on the phone
 *   thresholds    the manifest (or its thresholds)
 *   budgets       {number, name, secondRead} seconds
 *   detectMaxSide the long side of the copy the finder searches the quad on (null: the server's 900, which parity needs)
 *   now           clock in ms (injectable)
 *   parts         replacements for the ported pieces (tests): findCard, augmentedViews, artCrop, rotate180, isGuidePicture, wholeCard,
 *                 readCard, readName, secondRead, decideCard, scoreNames
 */
export function createPhoneMatcher({ embedder, index, sessions = null, getDecideIndexes = async () => null, thresholds = null, budgets = {}, now = defaultNow, parts = {}, detectMaxSide = null }) {
  const p = {
    findCard: defaultFindCard, augmentedViews: defaultAugmentedViews, artCrop: defaultArtCrop, rotate180: defaultRotate180, isGuidePicture: defaultIsGuide,
    wholeCard: defaultWholeCard, readCard: defaultReadCard, readName: defaultReadName, secondRead: defaultSecondRead, decideCard: defaultDecideCard, scoreNames: defaultScoreNames,
    ...parts,
  }
  const t = resolveThresholds(thresholds)
  const limits = { ...DEFAULT_BUDGETS, ...budgets }

  async function match(photo, { onStage = null, useText = true, signal = null } = {}) {
    const clock = timer(now)
    const started = now()
    const notes = []
    const stage = (name, fn) => {
      if (signal?.aborted) throw new Error('aborted')
      onStage?.(name)
      return clock.run(name, fn)
    }

    // 1. the card
    const found = await stage('finder', () => p.findCard(photo, detectMaxSide ? { hires: true, detectMaxSide } : { hires: true }))
    const detectionFound = found.source === 'quad'
    const fallback = detectionFound ? null : 'guide_crop' // the finder did not find the card: the guide crop (or the whole picture) stands in
    const upright = found.card
    const textCard = found.hires || upright

    // 2. the two orientations against the whole-card index
    const turnedCard = await stage('views', () => p.rotate180(upright))
    const first = await stage('embed', () => embedder.embed([upright, turnedCard]))
    const main = await stage('search', () => searchWhole(index, first))
    const margin = main.viewMax[1] - main.viewMax[0]
    const pictureFlipped = index.count > 0 && margin >= t.orient_margin
    const best = main.best

    // 3. the rest of the picture views for the oriented card
    const scoresFor = async flipped => {
      const oriented = flipped ? turnedCard : upright
      const extra = await stage('views', () => {
        const [tight, clahe] = p.augmentedViews(oriented)
        const pictures = [oriented, tight, clahe]
        return { tight, clahe, art: pictures.map(picture => p.artCrop(picture)) }
      })
      const embedded = await stage('embed', () => embedder.embed([extra.tight, extra.clahe, ...extra.art]))
      return stage('search', () => {
        const whole = new Float32Array(best) // a copy: the turned-card pass starts again from the two-view best
        maxInto(whole, searchWhole(index, embedded.slice(0, 2)).best)
        const artBest = searchArt(index, embedded.slice(2))
        return combineScores(index, whole, artBest)
      })
    }
    let picture = await scoresFor(pictureFlipped)

    // 4. the text
    let read = null
    let nameRead = null
    let flipped = pictureFlipped
    let how = 'picture'
    let wholeread = null
    const indexes = useText && sessions ? await getDecideIndexes() : null // no card database on the phone: nothing to read the text against
    const names = indexes?.names ?? null
    const wholeEligible = found.source !== 'whole' && p.isGuidePicture(photo)
    let ocrResult = null
    if (useText && sessions && indexes) {
      const secondReadApplies = wholeEligible
      const attempt = async isFlipped => {
        const result = await stage('ocr_number', () => p.readCard(sessions, textCard, {
          fast: true, flipped: isFlipped, readHp: false, stage: secondReadApplies ? 'first' : 'all', budget: limits.number,
        }))
        const name = names ? await stage('name', () => p.readName(sessions, textCard, { flipped: isFlipped, budget: limits.name })) : null
        return { result, name }
      }
      if (pictureFlipped) {
        ;({ result: ocrResult, name: nameRead } = await attempt(true))
        how = 'picture'
      } else {
        const upper = await attempt(false)
        const upperUsable = usable(upper.result, upper.name, names, p.scoreNames)
        if (fallback !== null || anyUsable(upperUsable)) {
          ;({ result: ocrResult, name: nameRead } = upper)
          how = 'default'
        } else {
          const lower = await attempt(true)
          if (better(usable(lower.result, lower.name, names, p.scoreNames), upperUsable)) {
            ;({ result: ocrResult, name: nameRead } = lower)
            flipped = true
            how = 'text'
          } else {
            ;({ result: ocrResult, name: nameRead } = upper)
            how = 'default'
          }
        }
      }

      // 5. the whole-picture second read
      if (secondReadApplies && !isComplete(ocrResult)) {
        const done = await stage('second_read', async () => {
          const wholeImage = p.wholeCard(photo)
          return p.secondRead(sessions, { first: ocrResult, wholeImage, textCard, flipped, fast: true, budget: limits.secondRead })
        })
        ocrResult = done.reading
        wholeread = done.info
      }
      if (ocrResult.number && !ocrResult.source) ocrResult.source = SOURCE_FINDER_CARD

      // 6. the text turned the card: the extra views follow the card's real orientation
      if (flipped !== pictureFlipped) picture = await scoresFor(flipped)

      read = {
        number: ocrResult.number ?? null,
        total: ocrResult.total ?? null,
        tokens: ocrResult.tokens ?? [],
        hp: ocrResult.hp ?? null,
        lines: (ocrResult.lines ?? []).map(line => (typeof line === 'string' ? line : line.text)),
        bodyLines: [],
        name: names ? (nameRead?.name || null) : undefined,
        numberSource: ocrResult.number ? (ocrResult.source ?? SOURCE_FINDER_CARD) : (ocrResult.source ?? null),
        numberConfidence: ocrResult.confidence ?? null,
      }
    }

    // 7. the decision
    let decided
    let pictureOnly = false
    if (indexes) {
      decided = await stage('decide', () => p.decideCard({
        pictureScores: picture, read, thresholds: t, indexes,
        options: { ...KEPT_OPTIONS, fallback: fallback !== null, topK: t.top_k },
      }))
    } else {
      pictureOnly = true
      notes.push(useText && sessions ? 'The card database is not on this phone: the picture alone, no decision.' : 'No text reading: the picture alone, no decision.')
      decided = await stage('decide', () => pictureOnlyAnswer(picture, t.top_k))
    }

    const total = now() - started
    const timings_ms = Object.fromEntries(STAGES.map(name => [name, roundMs(clock.timings[name])]))
    timings_ms.total = roundMs(total)
    return {
      version: MATCHER_VERSION,
      backend: embedder.backend ?? null,
      pictureOnly,
      notes,
      status: decided.status,
      decided: decided.decided,
      decision: decided.decision,
      cardId: decided.cardId,
      tcgCardId: decided.tcgCardId,
      mechanism: decided.mechanism,
      reason: decided.reason,
      unsure_reason: decided.unsure_reason,
      matches: decided.matches,
      candidates: decided.candidates,
      read: read && {
        number: read.number, total: read.total, hp: read.hp, name: read.name ?? null, tokens: read.tokens.slice(0, 12), lines: read.lines.slice(0, 8),
        numberSource: read.numberSource, numberConfidence: read.numberConfidence,
        corrected: decided.corrected ?? null, numberFromLookup: decided.numberFromLookup ?? null,
      },
      detection: {
        found: detectionFound, source: found.source, confidence: found.confidence, fallback,
        quad: found.quad ? found.quad.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]) : null,
        refused: found.refused ? { reason: found.refused.reason ?? null } : null,
      },
      orientation: { by: how, pictureMargin: Math.round(margin * 1e4) / 1e4, flipped, pictureFlipped },
      wholeread,
      stages: clock.trace,
      timings_ms,
    }
  }

  return { match, thresholds: t }
}

/** No catalogue on the phone: the closest pictures by id, no names, no decision. Same shape as `decideCard`'s answer. */
export function pictureOnlyAnswer(picture, topK = 20) {
  const { ids, scores, art } = picture
  const order = Array.from({ length: scores.length }, (_, row) => row).sort((a, b) => (scores[b] - scores[a]) || (a - b)).slice(0, topK)
  const round4 = value => Math.round(value * 1e4) / 1e4
  const matches = order.map((row, at) => ({
    card_id: ids[row], tcg_card_id: String(ids[row]).replace(/_[a-z]{2,3}$/, ''), similarity: round4(scores[row]), rank: at + 1, name: null, number: null, set: null, printed_total: null,
    picture_rank: at + 1, ...(art ? { art_similarity: round4(art[row]) } : {}),
  }))
  return {
    decided: false, cardId: null, tcgCardId: null, mechanism: null, reason: 'no_card_database', similarity: null, lead: null,
    candidates: matches.map(match => ({ id: match.card_id, tcgCardId: match.tcg_card_id, score: match.similarity, rank: match.rank, pictureRank: match.picture_rank, name: null, number: null, set: null, printedTotal: null, evidence: {} })),
    corrected: null, numberFromLookup: null, status: 'unsure', decision: null, unsure_reason: 'no_card_database', matches,
  }
}
