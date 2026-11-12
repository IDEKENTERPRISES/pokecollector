import { describe, expect, it } from 'vitest'
import { describeDecision, flatTimings, matcherBlock, matcherOutcome, MATCHER_RUNS, runMatcherRuns, stageTimes, summariseTimings } from './matcherRun'
import { fitSize } from './matchPhoto'

const result = (total, over = {}) => ({
  version: 11, backend: 'fp16 on WebGPU (worker)', decided: true, tcgCardId: 'sv1-25', cardId: 'sv1-25_en', mechanism: 'number_unique', unsure_reason: null,
  decision: { similarity: 0.93456, mechanism: 'number_unique' }, pictureOnly: false,
  matches: [{ tcg_card_id: 'sv1-25', similarity: 0.93456, name: 'Pikachu' }, { tcg_card_id: 'sv2-25', similarity: 0.5 }],
  candidates: [{ id: 'sv1-25_en', name: 'Pikachu', number: '25' }],
  read: { number: '25', total: '198', name: 'Pikachu', numberSource: 'finder_card' }, orientation: { by: 'default', flipped: false },
  detection: { source: 'quad', found: true }, wholeread: null, catalogue: { present: true, cards: 19659 },
  timings_ms: { finder: 600, views: 300, embed: 800, search: 90, ocr_number: 500, name: 200, second_read: 0, decide: 20, total },
  ...over,
})

describe('the three runs', () => {
  it('reports the first run and the median of the next two for every stage', () => {
    const results = [result(2500), result(2000, { timings_ms: { ...result(0).timings_ms, total: 2000, embed: 700 } }), result(2200, { timings_ms: { ...result(0).timings_ms, total: 2200, embed: 740 } })]
    expect(MATCHER_RUNS).toBe(3)
    expect(stageTimes(results, 'total')).toEqual({ first: 2500, median: 2100 })
    expect(stageTimes(results, 'embed')).toEqual({ first: 800, median: 720 })
    expect(Object.keys(summariseTimings(results))).toEqual(['finder', 'views', 'embed', 'search', 'ocr_number', 'name', 'second_read', 'decide', 'total'])
  })
  it('with a single run the median is that run, and a stage nobody timed is null', () => {
    expect(stageTimes([result(2500)], 'total')).toEqual({ first: 2500, median: 2500 })
    expect(stageTimes([{ timings_ms: {} }], 'total')).toEqual({ first: null, median: null })
  })
  it('flattens to the numbers the server stores', () => {
    const flat = flatTimings(summariseTimings([result(2500), result(2000), result(2200)]))
    expect(flat.matcher_total_first_ms).toBe(2500)
    expect(flat.matcher_total_median_ms).toBe(2100)
    expect(Object.values(flat).every(value => value === null || Number.isFinite(value))).toBe(true)
  })
  it('runs the matcher three times on a fresh copy of the photo each time', async () => {
    const copies = []
    const stages = []
    const client = { match: async (photo, { onStage }) => { copies.push(photo); onStage('finder'); return result(2000) } }
    const results = await runMatcherRuns({ client, copy: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }), onStage: (stage, n) => stages.push(`${n}:${stage}`) })
    expect(results).toHaveLength(3)
    expect(new Set(copies).size).toBe(3)
    expect(stages).toEqual(['1:finder', '2:finder', '3:finder'])
  })
})

describe('the block that is posted', () => {
  it('holds the decision, the top 20, the read and the stage times as short values', () => {
    const block = matcherBlock([result(2500), result(2000), result(2200)], { photo: { width: 1536, height: 2048, bytes: 400000 }, info: { mode: 'auto' } })
    expect(block).toMatchObject({
      version: 11, backend: 'fp16 on WebGPU (worker)', mode: 'auto', runs: 3, stable: true, decided: true, card: 'sv1-25', mechanism: 'number_unique', similarity: 0.9346,
      picture_only: false, read: { number: '25', total: '198', name: 'Pikachu', source: 'finder_card' }, photo: { width: 1536, height: 2048, bytes: 400000 },
    })
    expect(block.top20).toEqual([['sv1-25', 0.9346], ['sv2-25', 0.5]])
    expect(block.timings.total).toEqual([2500, 2100])
  })
  it('says when the runs disagreed with each other', () => {
    expect(matcherBlock([result(1), result(1, { tcgCardId: 'sv2-25' })]).stable).toBe(false)
  })
  it('an unsure run posts no card, and a picture-only run says so', () => {
    const unsure = matcherBlock([result(1, { decided: false, tcgCardId: null, mechanism: null, decision: null, unsure_reason: 'no_number_and_picture_not_clear' })])
    expect(unsure).toMatchObject({ decided: false, card: null, reason: 'no_number_and_picture_not_clear', similarity: null })
    expect(matcherBlock([result(1, { pictureOnly: true, decided: false, tcgCardId: null })]).picture_only).toBe(true)
  })
  it('the run outcome carries flat timings, the device, the block and the run id', () => {
    const outcome = matcherOutcome({ results: [result(2500), result(2000), result(2200)], device: { gpu: true }, runId: 'run-abc', photo: { width: 1, height: 1 }, info: { mode: 'wasm' } })
    expect(outcome.runId).toBe('run-abc')
    expect(outcome.timings.matcher_total_median_ms).toBe(2100)
    expect(outcome.matcher.mode).toBe('wasm')
  })
})

describe('describing a result', () => {
  it('names the card and the mechanism, or the reason it is unsure, or the missing card database', () => {
    expect(describeDecision(result(1))).toBe('Pikachu #25 · number_unique')
    expect(describeDecision(result(1, { decided: false, unsure_reason: 'number_matches_several_printings' }))).toBe('unsure (number_matches_several_printings)')
    expect(describeDecision(result(1, { pictureOnly: true }))).toMatch(/picture only/)
  })
})

describe('the photo the matcher runs on', () => {
  it('keeps the long side at 2048 like the server stores it, and never enlarges', () => {
    expect(fitSize(4032, 3024)).toEqual({ width: 2048, height: 1536 })
    expect(fitSize(3024, 4032)).toEqual({ width: 1536, height: 2048 })
    expect(fitSize(1920, 1080)).toEqual({ width: 1920, height: 1080 })
  })
})
