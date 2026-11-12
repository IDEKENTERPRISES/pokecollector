// The phone matcher's orchestration (step 3d): the order of the stages and the branching of CardMatcher.match, with stubbed embeddings,
// readers and finder pieces (tagged pictures instead of pixels), then an end-to-end replay on the step 1 generated photos with the real
// finder, the real decision rules and fake embeddings. No real scan photo, no model.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import jpeg from 'jpeg-js'
import { describe, expect, it } from 'vitest'
import catalogue from '../../../tests/fixtures/phone-matcher/v11/decide/catalogue.json'
import { artCrop, augmentedViews, findCard, isGuidePicture, rotate180 } from '../finder'
import { buildDecideIndexes } from '../decide/catalogue'
import { decideCard } from '../decide/decideCard'
import { buildPictureIndex } from './pictureIndex'
import { createPhoneMatcher, DEFAULT_BUDGETS, pictureOnlyAnswer } from './matcher'

const indexes = buildDecideIndexes(catalogue.rows)
const IDS = [...indexes.candidates.keys()]
const DIM = IDS.length

/** A picture index whose card `n` is the unit vector e_n (so a query's dot product with it is its n-th weight). */
function unitIndex(withArt = true, skipArt = []) {
  const file = ids => ({
    dim: DIM, count: ids.length, ids,
    rows: Int8Array.from(ids.flatMap(id => { const row = new Array(DIM).fill(0); row[IDS.indexOf(id)] = 127; return row })),
    scales: new Float32Array(ids.length).fill(1 / 127),
  })
  return buildPictureIndex([file(IDS)], withArt ? [file(IDS.filter(id => !skipArt.includes(id)))] : [])
}
/** A unit query that scores `weights[id]` (before normalising) against each named card. */
function query(weights) {
  const vector = new Float32Array(DIM)
  for (const [id, weight] of Object.entries(weights)) vector[IDS.indexOf(id)] = weight
  const norm = Math.hypot(...vector) || 1
  return vector.map(value => value / norm)
}
const idOf = name => IDS.find(id => indexes.candidates.get(id).name === name)

const reading = (over = {}) => ({
  number: null, total: null, setCode: null, hp: null, tokens: [], lines: [], complete: false, source: null, confidence: null, seconds: 0.2, flipped: false, attempts: 1, strips: [], ...over,
})
const complete = (number, total, over = {}) => reading({ number, total, source: 'finder_card', confidence: 0.95, lines: [{ text: `${number}/${total}`, score: 0.95, box: [0, 0, 1, 1] }], tokens: [], ...over })

/** Tagged pictures instead of pixels: every finder piece returns a labelled object the stubbed embedder understands. */
function harness({
  source = 'quad', guide = true, found = {}, embedVector = () => query({ [idOf('Pikachu')]: 1 }), read = () => complete('25', '198'), nameRead = () => ({ name: 'Pikachu', lines: [], confidence: 0.9 }),
  second = null, decide = null, cardDb = true, useIndex = unitIndex(), budgets,
} = {}) {
  const calls = { embed: [], read: [], name: [], second: [], decide: [], views: [], rotate: 0 }
  const upright = { tag: 'upright', width: 630, height: 880 }
  const hires = { tag: 'hires', width: 1008, height: 1408 }
  const turned = { tag: 'turned', width: 630, height: 880 }
  const parts = {
    findCard: (photo, options) => ({ card: upright, hires, source, quad: source === 'quad' ? [[0, 0], [1, 0], [1, 1], [0, 1]] : null, refused: null, confidence: 0.9, ...found, _options: options }),
    rotate180: image => { calls.rotate += 1; return image === upright ? turned : upright },
    augmentedViews: oriented => { calls.views.push(oriented.tag); return [{ tag: `tight(${oriented.tag})` }, { tag: `clahe(${oriented.tag})` }] },
    artCrop: picture => ({ tag: `art(${picture.tag})` }),
    isGuidePicture: () => guide,
    wholeCard: () => ({ tag: 'whole' }),
    readCard: async (sessions, card, options) => { calls.read.push({ card: card.tag, ...options }); return read(options, calls.read.length) },
    readName: async (sessions, card, options) => { calls.name.push({ card: card.tag, ...options }); return nameRead(options, calls.name.length) },
    secondRead: async (sessions, args) => { calls.second.push({ ...args, textCard: args.textCard.tag, wholeImage: args.wholeImage.tag }); return second ? second(args) : { reading: args.first, info: { tried: true, rescued: false, skipped: null, last_resort: null } } },
    ...(decide ? { decideCard: (args) => { calls.decide.push(args); return decideCard(args) } } : { decideCard: args => { calls.decide.push(args); return decideCard(args) } }),
  }
  const embedder = {
    backend: 'stub',
    async embed(images) { calls.embed.push(images.map(image => image.tag)); return images.map((image, n) => embedVector(image, n, calls.embed.length)) },
  }
  const matcher = createPhoneMatcher({
    embedder, index: useIndex, sessions: { stub: true }, getDecideIndexes: async () => (cardDb ? indexes : null), parts, budgets,
    now: (() => { let t = 0; return () => (t += 1) })(),
  })
  return { matcher, calls, upright, turned }
}
const photo = { data: new Uint8ClampedArray(4), width: 768, height: 1024 }

describe('the order of the stages', () => {
  it('runs the finder, the views, the embeddings and the search for both orientations, then the text, then the decision', async () => {
    const { matcher, calls } = harness()
    const result = await matcher.match(photo)
    expect(result.stages).toEqual(['finder', 'views', 'embed', 'search', 'views', 'embed', 'search', 'ocr_number', 'name', 'decide'])
    expect(calls.embed).toEqual([
      ['upright', 'turned'], // orientation: the card and its 180 degree turn
      ['tight(upright)', 'clahe(upright)', 'art(upright)', 'art(tight(upright))', 'art(clahe(upright))'], // the two extra views and the three artwork windows
    ])
    expect(calls.views).toEqual(['upright'])
    expect(result.decided).toBe(true)
    expect(result.tcgCardId).toBe('sv1-25')
    expect(result.mechanism).toMatch(/number/)
    expect(Object.keys(result.timings_ms)).toEqual(['finder', 'views', 'embed', 'search', 'ocr_number', 'name', 'second_read', 'decide', 'total'])
    expect(result.timings_ms.second_read).toBe(0)
    expect(result.backend).toBe('stub')
  })

  it('asks the finder for the sharper copy the text is read from, and reads the text from it', async () => {
    const { matcher, calls } = harness()
    await matcher.match(photo)
    expect(calls.read[0].card).toBe('hires')
    expect(calls.name[0].card).toBe('hires')
  })

  it('reads the number with the budgets given (the server\'s 0.9 s by default), and the budgets are configurable', async () => {
    const standard = harness()
    await standard.matcher.match(photo)
    expect(standard.calls.read[0]).toMatchObject({ budget: DEFAULT_BUDGETS.number, fast: true, readHp: false })
    expect(standard.calls.name[0].budget).toBe(DEFAULT_BUDGETS.name)
    const tight = harness({ budgets: { number: 0.4, name: 0.3, secondRead: 0.5 }, read: () => complete('25', '198') })
    await tight.matcher.match(photo)
    expect(tight.calls.read[0].budget).toBe(0.4)
    expect(tight.calls.name[0].budget).toBe(0.3)
  })
})

describe('the whole-picture second read (wholeread)', () => {
  const incomplete = () => reading({ number: '25', source: 'finder_card', confidence: 0.9 })

  it('happens only when the number is not complete, and then the first read holds back its last-resort band', async () => {
    const { matcher, calls, } = harness({ read: incomplete })
    const result = await matcher.match(photo)
    expect(calls.read[0].stage).toBe('first')
    expect(calls.second).toHaveLength(1)
    expect(calls.second[0]).toMatchObject({ textCard: 'hires', wholeImage: 'whole', flipped: false, fast: true, budget: DEFAULT_BUDGETS.secondRead })
    expect(result.stages).toContain('second_read')
    expect(result.stages.indexOf('second_read')).toBeGreaterThan(result.stages.indexOf('name'))
    expect(result.wholeread).toMatchObject({ tried: true })
  })

  it('is skipped for a complete number, and then the first read is the whole read (no held-back band)', async () => {
    const { matcher, calls } = harness({ read: () => complete('25', '198') })
    const result = await matcher.match(photo)
    expect(calls.second).toHaveLength(0)
    expect(result.stages).not.toContain('second_read')
    expect(result.wholeread).toBeNull()
    expect(calls.read[0].stage).toBe('first') // a guide picture: the band waits for the second read, which was not needed
  })

  it('is skipped for a picture that is not a guide picture, and the first read then runs the whole ladder', async () => {
    const { matcher, calls } = harness({ guide: false, read: incomplete })
    const result = await matcher.match(photo)
    expect(calls.second).toHaveLength(0)
    expect(calls.read[0].stage).toBe('all')
    expect(result.stages).not.toContain('second_read')
  })

  it('is skipped when the finder fell back to the whole picture (it IS the whole picture already)', async () => {
    const { matcher, calls } = harness({ source: 'whole', read: incomplete })
    await matcher.match(photo)
    expect(calls.second).toHaveLength(0)
  })

  it('uses what the second read returned: the merged reading with its source and confidence reach the decision (wholestrict)', async () => {
    const merged = complete('25', '198', { source: 'whole_picture', confidence: 0.91 })
    const { matcher, calls } = harness({ read: incomplete, second: async () => ({ reading: merged, info: { tried: true, rescued: true, skipped: null, last_resort: null } }) })
    const result = await matcher.match(photo)
    const args = calls.decide[0]
    expect(args.read).toMatchObject({ number: '25', total: '198', numberSource: 'whole_picture', numberConfidence: 0.91 })
    expect(args.options).toMatchObject({ wholeStrict: true, numberOnce: true, reprint: false })
    expect(result.wholeread.rescued).toBe(true)
  })
})

describe('which way up the card is', () => {
  const pikachu = idOf('Pikachu')
  // upright scores low, turned scores high: the card is upside down in the picture
  const spread = query(Object.fromEntries(IDS.slice(0, 10).map(id => [id, 1]))) // matches no card well: its best score is about 0.32
  const upsideDown = image => (image.tag === 'upright' ? spread : query({ [pikachu]: 1 }))

  it('trusts the picture when the turned card scores ORIENT_MARGIN higher: reads turned only, and builds the extra views from the turned card', async () => {
    const { matcher, calls } = harness({ embedVector: upsideDown })
    const result = await matcher.match(photo)
    expect(result.orientation).toMatchObject({ by: 'picture', flipped: true, pictureFlipped: true })
    expect(calls.read).toHaveLength(1)
    expect(calls.read[0].flipped).toBe(true)
    expect(calls.views).toEqual(['turned'])
    expect(calls.embed[1][0]).toBe('tight(turned)')
    expect(result.orientation.pictureMargin).toBeGreaterThanOrEqual(0.1)
  })

  it('does not flip on a margin below ORIENT_MARGIN (a holo with glare scores about the same both ways)', async () => {
    const closer = image => (image.tag === 'turned' ? query({ [pikachu]: 1, [idOf('Lapras')]: 0.5 }) : query({ [pikachu]: 1, [idOf('Lapras')]: 0.52 }))
    const { matcher, calls } = harness({ embedVector: closer })
    const result = await matcher.match(photo)
    expect(result.orientation.pictureFlipped).toBe(false)
    expect(calls.read.map(call => call.flipped)).toEqual([false])
  })

  it('lets the text turn the card when upright gave nothing and the turned card gives a number: the views are made again', async () => {
    const { matcher, calls } = harness({ read: ({ flipped }) => (flipped ? complete('25', '198') : reading()), nameRead: ({ flipped }) => ({ name: flipped ? 'Pikachu' : null, lines: [], confidence: null }) })
    const result = await matcher.match(photo)
    expect(calls.read.map(call => call.flipped)).toEqual([false, true])
    expect(result.orientation).toMatchObject({ by: 'text', flipped: true, pictureFlipped: false })
    expect(calls.views).toEqual(['upright', 'turned']) // the extra views follow the card's real orientation
    expect(result.stages.filter(stage => stage === 'embed')).toHaveLength(3)
    expect(result.stages.filter(stage => stage === 'search')).toHaveLength(3)
    expect(result.decided).toBe(true)
  })

  it('keeps the upright read when the turned one is no better', async () => {
    const { matcher, calls } = harness({ read: () => reading(), nameRead: () => ({ name: null, lines: [], confidence: null }) })
    const result = await matcher.match(photo)
    expect(calls.read.map(call => call.flipped)).toEqual([false, true])
    expect(result.orientation).toMatchObject({ by: 'default', flipped: false })
    expect(calls.views).toEqual(['upright'])
  })

  it('reads one orientation only when the finder did not find the card (the guide-crop fallback)', async () => {
    const { matcher, calls } = harness({ source: 'guide', read: () => reading(), nameRead: () => ({ name: null, lines: [], confidence: null }) })
    const result = await matcher.match(photo)
    expect(calls.read).toHaveLength(1)
    expect(result.detection).toMatchObject({ found: false, fallback: 'guide_crop' })
    expect(calls.decide[0].options.fallback).toBe(true)
  })

  it('does not refuse a decision for a card the finder found (fallback is false)', async () => {
    const { matcher, calls } = harness()
    await matcher.match(photo)
    expect(calls.decide[0].options.fallback).toBe(false)
  })
})

describe('the picture scores', () => {
  it('score every card as (whole + artwork) / 2 and pass the full vectors and the artwork vector to the decision', async () => {
    const pikachu = idOf('Pikachu')
    const { matcher, calls } = harness({ embedVector: image => (image.tag.startsWith('art') ? query({ [pikachu]: 0.5, [idOf('Lapras')]: 1 }) : query({ [pikachu]: 1 })) })
    await matcher.match(photo)
    const { pictureScores } = calls.decide[0]
    const row = IDS.indexOf(pikachu)
    expect(pictureScores.ids).toEqual(IDS)
    expect(pictureScores.scores).toHaveLength(IDS.length)
    const art = 0.5 / Math.hypot(0.5, 1)
    expect(pictureScores.art[row]).toBeCloseTo(art, 5)
    expect(pictureScores.scores[row]).toBeCloseTo((1 + art) / 2, 5)
  })

  it('a card the artwork index lacks scores its whole-card similarity for the artwork part', async () => {
    const pikachu = idOf('Pikachu')
    const { matcher, calls } = harness({ useIndex: unitIndex(true, [pikachu]) })
    await matcher.match(photo)
    const row = IDS.indexOf(pikachu)
    expect(calls.decide[0].pictureScores.scores[row]).toBeCloseTo(1, 5)
  })
})

describe('without the offline card database', () => {
  it('runs picture-only, marked as such, with no text reading and no decision', async () => {
    const { matcher, calls } = harness({ cardDb: false })
    const result = await matcher.match(photo)
    expect(result.pictureOnly).toBe(true)
    expect(result.decided).toBe(false)
    expect(result.reason).toBe('no_card_database')
    expect(calls.read).toHaveLength(0)
    expect(calls.name).toHaveLength(0)
    expect(result.matches).toHaveLength(20)
    expect(result.matches[0].tcg_card_id).toBe('sv1-25')
    expect(result.notes.join(' ')).toMatch(/card database/)
  })

  it('pictureOnlyAnswer lists the closest pictures by score, best first', () => {
    const answer = pictureOnlyAnswer({ ids: ['a_en', 'b_en', 'c_en'], scores: [0.2, 0.9, 0.5], art: [0.1, 0.8, 0.3] }, 2)
    expect(answer.matches.map(match => match.card_id)).toEqual(['b_en', 'c_en'])
    expect(answer.matches[0]).toMatchObject({ tcg_card_id: 'b', similarity: 0.9, art_similarity: 0.8, rank: 1 })
  })
})

describe('progress and stopping', () => {
  it('reports every stage as it starts, and stops when asked', async () => {
    const seen = []
    const first = harness()
    await first.matcher.match(photo, { onStage: stage => seen.push(stage) })
    expect(seen.slice(0, 3)).toEqual(['finder', 'views', 'embed'])
    const controller = new AbortController()
    const second = harness()
    await expect(second.matcher.match(photo, { signal: controller.signal, onStage: stage => { if (stage === 'embed') controller.abort() } })).rejects.toThrow('aborted')
  })
})

// ── an end-to-end replay on the step 1 generated photos: the real finder, the real views, the real decision rules ─────────────────────

const photos = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures', 'phone-matcher', 'v11', 'finder', 'photos')
function decode(name) {
  const { data, width, height } = jpeg.decode(readFileSync(resolve(photos, name)), { useTArray: true, formatAsRGBA: true })
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height }
}

describe('end to end on the generated photos (real finder and views, fake embeddings and reading)', () => {
  const pikachu = idOf('Pikachu')
  const run = async (name, options = {}) => {
    const calls = { embed: [], read: [] }
    const embedder = { backend: 'fake', async embed(images) { calls.embed.push(images.map(image => [image.width, image.height])); return images.map(() => query({ [pikachu]: 1 })) } }
    const matcher = createPhoneMatcher({
      embedder, index: unitIndex(), sessions: {}, getDecideIndexes: async () => indexes,
      parts: {
        readCard: async (sessions, card, opts) => { calls.read.push({ width: card.width, height: card.height, ...opts }); return options.read ? options.read(opts) : complete('25', '198') },
        readName: async () => ({ name: 'Pikachu', lines: [], confidence: 0.9 }),
        secondRead: async (sessions, args) => ({ reading: args.first, info: { tried: true, rescued: false, skipped: null, last_resort: null } }),
      },
    })
    const result = await matcher.match(decode(name))
    return { result, calls }
  }

  it('a whole camera frame: finds the card, embeds the seven pictures of the kept set at the sizes the server uses, and decides', async () => {
    const { result, calls } = await run('frame-1.jpg')
    expect(result.detection).toMatchObject({ found: true, source: 'quad' })
    const card = [630, 880]
    const art = artCrop({ data: new Uint8ClampedArray(630 * 880 * 4), width: 630, height: 880 })
    expect(calls.embed).toEqual([[card, card], [card, card, [art.width, art.height], [art.width, art.height], [art.width, art.height]]])
    expect(result.stages).toEqual(['finder', 'views', 'embed', 'search', 'views', 'embed', 'search', 'ocr_number', 'name', 'decide'])
    expect(result.decided).toBe(true)
    expect(result.tcgCardId).toBe('sv1-25')
    expect(result.detection.quad).toHaveLength(4)
  }, 60000)

  it('reads the text from the sharper copy of the card when the photo holds more detail than 630 pixels', async () => {
    const { calls } = await run('guide-cut.jpg', { read: () => reading() })
    expect([calls.read[0].width, calls.read[0].height]).toEqual([733, 1024]) // the whole picture's sharper copy, not the 630x880 card
  }, 60000)

  it('a guide picture (the camera crop) with a cut-out card and no complete number gets the whole-picture second read', async () => {
    const { result, calls } = await run('guide-tight.jpg', { read: () => reading({ number: '25', source: 'finder_card', confidence: 0.9 }) })
    expect(result.detection.found).toBe(true)
    expect(isGuidePicture(decode('guide-tight.jpg'))).toBe(true)
    expect(calls.read[0].stage).toBe('first')
    expect(result.stages).toContain('second_read')
    expect(result.wholeread).toMatchObject({ tried: true })
  }, 60000)

  it('a refused quad falls back to the whole picture: not found, one orientation, no second read, strict fallback rules', async () => {
    const { result, calls } = await run('guide-cut.jpg', { read: () => reading() })
    expect(result.detection).toMatchObject({ found: false, source: 'whole', fallback: 'guide_crop' })
    expect(calls.read).toHaveLength(1)
    expect(result.stages).not.toContain('second_read')
    expect(result.decided).toBe(false)
  }, 60000)

  it('is deterministic: the same photo gives the same answer twice', async () => {
    const first = await run('frame-2.jpg')
    const second = await run('frame-2.jpg')
    expect(second.result.matches).toEqual(first.result.matches)
    expect(second.result.tcgCardId).toBe(first.result.tcgCardId)
  }, 60000)

  it('the finder pieces the matcher imports are the ported ones', () => {
    expect(typeof findCard).toBe('function')
    expect(typeof augmentedViews).toBe('function')
    expect(typeof rotate180).toBe('function')
  })
})
