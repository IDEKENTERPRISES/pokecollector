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
  second = null, decide = null, cardDb = true, useIndex = unitIndex(), budgets, where = 'here', sessions = { stub: true }, ocr, resources = null, catalogueMs = 0,
} = {}) {
  const clockTime = { value: 0 }
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
    readCard: async (sessions, card, options) => { order.push('read'); calls.read.push({ card: card.tag, ...options }); return read(options, calls.read.length) },
    readName: async (sessions, card, options) => { calls.name.push({ card: card.tag, ...options }); return nameRead(options, calls.name.length) },
    secondRead: async (sessions, args) => { calls.second.push({ ...args, textCard: args.textCard.tag, wholeImage: args.wholeImage.tag }); return second ? second(args) : { reading: args.first, info: { tried: true, rescued: false, skipped: null, last_resort: null } } },
    ...(decide ? { decideCard: (args) => { calls.decide.push(args); return decideCard(args) } } : { decideCard: args => { calls.decide.push(args); return decideCard(args) } }),
  }
  const order = []
  const embedder = {
    backend: 'stub',
    where,
    async embed(images) { order.push('embed-start'); calls.embed.push(images.map(image => image.tag)); await new Promise(resolve => setTimeout(resolve, 5)); order.push('embed-end'); return images.map((image, n) => embedVector(image, n, calls.embed.length)) },
  }
  const matcher = createPhoneMatcher({
    embedder, index: useIndex, sessions, ocr, resources, getDecideIndexes: async () => { clockTime.value += catalogueMs; return cardDb ? indexes : null }, parts, budgets,
    now: () => (clockTime.value += 1),
  })
  return { matcher, calls, upright, turned, order }
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
    expect(Object.keys(result.timings_ms)).toEqual(['finder', 'views', 'embed', 'search', 'ocr_number', 'name', 'second_read', 'catalogue', 'decide', 'total', 'other', 'warm', 'saved'])
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
    await first.matcher.match(photo, { onStage: (stage, info) => { if (!info) seen.push(stage) } })
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

describe('the overlap option and the reader statistics (step 3d fix)', () => {
  const pikachu = () => idOf('Pikachu')

  it('starts the upright read before the embeddings finish when the model runs on the main thread, and gives the sequential answer', async () => {
    const sequential = harness({ where: 'main thread' })
    const a = await sequential.matcher.match(photo)
    const overlapped = harness({ where: 'main thread' })
    const b = await overlapped.matcher.match(photo, { overlap: true })
    expect(b.overlapped).toBe(true)
    expect(overlapped.order.indexOf('read')).toBeLessThan(overlapped.order.lastIndexOf('embed-end'))
    expect(sequential.order.indexOf('read')).toBeGreaterThan(sequential.order.lastIndexOf('embed-end'))
    expect(b.tcgCardId).toBe(a.tcgCardId)
    expect(b.matches).toEqual(a.matches)
    expect(overlapped.calls.read).toHaveLength(1) // the speculative read is the read
  })

  it('does not overlap when the model runs in the worker (one thread: nothing to gain)', async () => {
    const { matcher, order } = harness({ where: 'here' })
    const result = await matcher.match(photo, { overlap: true })
    expect(result.overlapped).toBe(false)
    expect(order.indexOf('read')).toBeGreaterThan(order.lastIndexOf('embed-end'))
  })

  it('throws the speculative upright read away when the picture says the card is turned, and reads it turned: the sequential answer', async () => {
    const spread = query(Object.fromEntries(IDS.slice(0, 10).map(id => [id, 1])))
    const embedVector = image => (image.tag === 'upright' ? spread : query({ [pikachu()]: 1 }))
    const sequential = harness({ where: 'main thread', embedVector })
    const a = await sequential.matcher.match(photo)
    const overlapped = harness({ where: 'main thread', embedVector })
    const b = await overlapped.matcher.match(photo, { overlap: true })
    expect(overlapped.calls.read.map(call => call.flipped)).toEqual([false, true])
    expect(sequential.calls.read.map(call => call.flipped)).toEqual([true])
    expect(b.orientation).toMatchObject({ by: 'picture', flipped: true })
    expect(b.tcgCardId).toBe(a.tcgCardId)
    expect(b.matches).toEqual(a.matches)
  })

  it('passes the lean ladder options to the reader, and nothing when the server ladder is wanted', async () => {
    const lean = harness({ ocr: { maxSteps: 3 } })
    await lean.matcher.match(photo)
    expect(lean.calls.read[0]).toMatchObject({ maxSteps: 3 })
    const server = harness()
    await server.matcher.match(photo)
    expect(server.calls.read[0].maxSteps).toBeNull()
  })

  it('reports the model calls of each ocr stage from the recording sessions, and the ladder that ran', async () => {
    const taken = { ocr_number: { det: { n: 2, ms: 300, perCall: 150, inputs: ['1x3x128x704'] }, rec: { n: 2, ms: 80, perCall: 40, inputs: ['1x3x48x320'] } } }
    const sessions = { mark: () => {}, take: () => taken }
    const { matcher } = harness({ sessions, read: () => complete('25', '198', { attempts: 2, seconds: 0.4, stopped: 'accepted', strips: [{ label: 'number-left-tight', variant: 'plain', zoom: 2, ms: 180 }, { label: 'hp', ms: 5 }] }) })
    const result = await matcher.match(photo)
    expect(result.ocrStats.calls).toBe(taken)
    expect(result.ocrStats.number).toMatchObject({ attempts: 2, stopped: 'accepted', budget: 0.9, steps: [{ label: 'number-left-tight', ms: 180 }] })
  })

  it('reports the stage end times to the caller', async () => {
    const ends = []
    await harness().matcher.match(photo, { onStage: (stage, info) => { if (info) ends.push(stage) } })
    expect(ends).toContain('finder')
    expect(ends).toContain('decide')
  })
})

describe('low memory mode (step 3d fix)', () => {
  /** Resources that log what is open when, so the test can see what is alive at each step. */
  function lowHarness(extra = {}) {
    const events = []
    const open = new Set()
    const resources = {
      openIndex: async () => { events.push('open index'); open.add('index'); return unitIndex() },
      closeIndex: async () => { events.push('close index'); open.delete('index') },
      openReader: async () => { events.push('open reader'); open.add('reader'); return { stub: true } },
      closeReader: async () => { events.push('close reader'); open.delete('reader') },
      closeDecide: async () => { events.push('close decide'); open.delete('decide') },
    }
    const built = harness({ sessions: null, resources, useIndex: null, ...extra })
    const embed = built.matcher // wrap embed to log what is alive during it
    return { ...built, events, open, resources, embed }
  }

  it('embeds all seven pictures in one batch with nothing else loaded, then searches and releases the index, then reads with only the reader open', async () => {
    const seen = {}
    const built = lowHarness()
    const original = built.resources.openIndex
    built.resources.openIndex = async () => { seen.embedsBeforeIndex = built.calls.embed.length; seen.openAtIndex = [...built.open]; return original() }
    const readCard = built.calls.read
    const result = await built.matcher.match(photo, { lowMemory: true })
    expect(built.calls.embed).toHaveLength(1)
    expect(built.calls.embed[0]).toEqual(['upright', 'turned', 'tight(upright)', 'clahe(upright)', 'art(upright)', 'art(tight(upright))', 'art(clahe(upright))'])
    expect(seen.embedsBeforeIndex).toBe(1) // the index is opened after the embeddings
    expect(seen.openAtIndex).toEqual([]) // nothing else is open while it is
    expect(built.events.indexOf('close index')).toBeLessThan(built.events.indexOf('open reader')) // never both at once
    expect(built.events.indexOf('close reader')).toBeLessThan(built.events.indexOf('close decide'))
    expect(built.events.at(-1)).toBe('close decide')
    expect(readCard).toHaveLength(1)
    expect(result.lowMemory).toBe(true)
    expect(result.decided).toBe(true)
    expect(result.tcgCardId).toBe('sv1-25')
  })

  it('gives the same answer as the normal run', async () => {
    const normal = await harness().matcher.match(photo)
    const low = await lowHarness().matcher.match(photo, { lowMemory: true })
    expect(low.matches).toEqual(normal.matches)
    expect(low.tcgCardId).toBe(normal.tcgCardId)
    expect(low.mechanism).toBe(normal.mechanism)
    expect(low.orientation.flipped).toBe(normal.orientation.flipped)
  })

  it('a turned card: the extra views come from the turned card in a second small batch, and the answer is the same', async () => {
    const spread = query(Object.fromEntries(IDS.slice(0, 10).map(id => [id, 1])))
    const embedVector = image => (image.tag === 'upright' ? spread : query({ [idOf('Pikachu')]: 1 }))
    const normal = await harness({ embedVector }).matcher.match(photo)
    const built = lowHarness({ embedVector })
    const low = await built.matcher.match(photo, { lowMemory: true })
    expect(built.calls.embed).toHaveLength(2)
    expect(built.calls.embed[1][0]).toBe('tight(turned)')
    expect(low.orientation).toMatchObject({ by: 'picture', flipped: true })
    expect(low.matches).toEqual(normal.matches)
    expect(built.open.size).toBe(0) // everything was released at the end
  })

  it('when the text turns the card the index is opened again for the new views and released again', async () => {
    const built = lowHarness({ read: ({ flipped }) => (flipped ? complete('25', '198') : reading()), nameRead: ({ flipped }) => ({ name: flipped ? 'Pikachu' : null, lines: [], confidence: null }) })
    const result = await built.matcher.match(photo, { lowMemory: true })
    expect(result.orientation.by).toBe('text')
    expect(built.events.filter(event => event === 'open index')).toHaveLength(2)
    expect(built.events.filter(event => event === 'close index')).toHaveLength(2)
    expect(built.open.size).toBe(0)
  })

  it('without the resources the option does nothing (the normal run)', async () => {
    const { matcher } = harness()
    const result = await matcher.match(photo, { lowMemory: true })
    expect(result.lowMemory).toBe(false)
  })
})

describe('honest totals, overlap reasons, ladder steps and the decided card rank (round 2)', () => {
  it('times the card database index build as its own stage and gives the warm per-card time without it', async () => {
    const result = await harness({ catalogueMs: 1000 }).matcher.match(photo)
    expect(result.timings_ms.catalogue).toBeGreaterThanOrEqual(1000)
    expect(result.timings_ms.warm).toBeCloseTo(result.timings_ms.total - result.timings_ms.catalogue, 0)
    expect(result.timings_ms.other).toBeGreaterThanOrEqual(0)
    expect(result.timings_ms.saved).toBe(0)
  })

  it('says why overlap was not used: low memory, a model in the worker, or no text reading', async () => {
    const worker = await harness({ where: 'here' }).matcher.match(photo, { overlap: true })
    expect(worker.overlap).toEqual({ asked: true, used: false, why: expect.stringMatching(/the model runs in the worker/) })
    const none = await harness({ where: 'main thread' }).matcher.match(photo, { overlap: true, useText: false })
    expect(none.overlap.why).toBe('no text reading')
    const used = await harness({ where: 'main thread' }).matcher.match(photo, { overlap: true })
    expect(used.overlap).toEqual({ asked: true, used: true, why: null })
    const quiet = await harness().matcher.match(photo)
    expect(quiet.overlap).toEqual({ asked: false, used: false, why: null })
  })

  it('reports each ladder step with the lines it found and the number held after it, the text input size, and the decided card picture rank', async () => {
    const strips = [
      { label: 'number-left-tight', variant: 'plain', zoom: 2, ms: 88, lines: [{ text: '061', score: 0.9 }], after: { number: '061', total: null } },
      { label: 'bottom-wide', variant: 'clahe', zoom: 2, ms: 771, lines: [{ text: '061/128', score: 0.8 }], after: { number: '061', total: '128' } },
    ]
    const named = { name: null, lines: [], confidence: null, strips: [{ label: 'name-line', variant: 'plain', zoom: 2, ms: 74, lines: [], after: { name: null } }] }
    const { matcher } = harness({ read: () => complete('25', '198', { strips }), nameRead: () => named })
    const result = await matcher.match(photo)
    expect(result.ocrStats.number.steps[0]).toMatchObject({ label: 'number-left-tight', lines: 1, text: '061', after: '061/-' })
    expect(result.ocrStats.number.steps[1]).toMatchObject({ label: 'bottom-wide', after: '061/128' })
    expect(result.ocrStats.name.steps[0]).toMatchObject({ label: 'name-line', lines: 0, text: '', after: null })
    expect(result.textInput).toEqual({ source: 'photo', width: 1008, height: 1408 })
    expect(result.decided).toBe(true)
    expect(result.decisionRank).toMatchObject({ picture_rank: 1, similarity: expect.any(Number) })
  })
})
