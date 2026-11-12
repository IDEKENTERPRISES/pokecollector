import { describe, expect, it } from 'vitest'
import {
  buildDecideIndexes, buildDecideIndexesAsync, candidateFromRow, catalogueSignature, createLazyIndexes, decideCard, loadCatalogueRows, scoresFromTopK,
} from './index.js'
import { generateCatalogue } from './generated.js'

// carddb's payload format (offline_carddb.CARD_FIELDS) in a store with the same two read functions the real store has.
const FIELDS = ['id', 'tcg_card_id', 'name', 'set_id', 'number', 'rarity', 'supertype', 'hp', 'artist', 'regulation_mark', 'suffix', 'card_effect', 'attacks', 'abilities', 'images_small', 'is_digital', 'lang']
const card = (set, number, name, extra = {}) => {
  const row = { id: `${set}-${number}_en`, tcg_card_id: `${set}-${number}`, name, set_id: set, number, rarity: 'Common', supertype: 'Pokémon', hp: '70', artist: 'A', regulation_mark: 'G', suffix: null, card_effect: null, attacks: null, abilities: null, images_small: 'x.webp', is_digital: false, lang: 'en', ...extra }
  return FIELDS.map(field => row[field])
}
const payloads = {
  sv1_en: { set: { id: 'sv1_en', tcg_set_id: 'sv1', name: 'Scarlet & Violet', abbreviation: 'SVI', total: 258, printed_total: 198, is_digital: false, lang: 'en' }, fields: FIELDS, cards: [
    card('sv1', '25', 'Pikachu', { attacks: JSON.stringify([{ name: 'Thunder Jolt', effect: 'Flip a coin. If tails, this Pokemon does 30 damage to itself.' }]) }),
    card('sv1', '26', 'Raichu', { is_digital: true }), card('sv1', '27', 'Sandshrew', { images_small: '' }),
    card('sv1', '28', 'Sandslash', { attacks: [{ name: 'Slash', effect: 'This attack does 50 damage.' }] }),
  ] },
  pk_en: { set: { id: 'pk_en', tcg_set_id: 'pk', name: 'Pocket Set', abbreviation: 'PKT', total: 5, is_digital: true, lang: 'en' }, fields: FIELDS, cards: [card('pk', '1', 'Digital Mon')] },
}
const makeStore = (hash = 'H1') => ({
  getMeta: async () => ({ hash, sets: 2 }),
  scanSets: async (lang, visit) => { for (const payload of Object.values(payloads)) visit(payload); return true },
})

describe('loadCatalogueRows', () => {
  it('reads the stored set payloads, joins the set and flags what is missing', async () => {
    const { rows, signature, printedTotalMissing } = await loadCatalogueRows(makeStore())
    expect(rows).toHaveLength(5)
    expect(signature).toBe(catalogueSignature({ hash: 'H1', sets: 2 }))
    expect(printedTotalMissing).toBe(1) // the pocket set has no printed_total
    expect(rows[0]).toMatchObject({ id: 'sv1-25_en', tcg_card_id: 'sv1-25', set_abbreviation: 'SVI', printed_total: 198, set_name: 'Scarlet & Violet' })
    expect(rows.at(-1).is_digital).toBe(true) // from the set
  })

  it('accepts an object that holds the store, and says so when it has none', async () => {
    expect((await loadCatalogueRows({ store: makeStore() })).rows).toHaveLength(5)
    await expect(loadCatalogueRows({ sets: () => [] })).rejects.toThrow(/store/)
  })

  it('leaves the printed total unknown when carddb has none, or falls back to the set total on request', async () => {
    const withoutTotals = { getMeta: async () => ({ hash: 'H' }), scanSets: async (lang, visit) => { visit({ ...payloads.sv1_en, set: { ...payloads.sv1_en.set, printed_total: undefined } }) } }
    const plain = await loadCatalogueRows(withoutTotals)
    expect(plain.rows[0].printed_total).toBeNull()
    expect(plain.printedTotalMissing).toBe(4)
    const fallback = await loadCatalogueRows(withoutTotals, { totalFallback: 'total' })
    expect(fallback.rows[0].printed_total).toBe(258)
  })

  it('returns nothing when no English data is stored', async () => {
    const empty = await loadCatalogueRows({ getMeta: async () => null, scanSets: async () => true })
    expect(empty).toEqual({ rows: [], signature: null, printedTotalMissing: 0 })
  })
})

describe('buildDecideIndexes', () => {
  it('keeps what the server indexes and maps ids by identity', async () => {
    const { rows } = await loadCatalogueRows(makeStore())
    const indexes = buildDecideIndexes(rows)
    expect([...indexes.candidates.keys()].sort()).toEqual(['sv1-25_en', 'sv1-28_en']) // digital, picture-less and digital-set cards are out
    expect(indexes.candidates.get('sv1-25_en')).toMatchObject({ id: 'sv1-25', tcg_card_id: 'sv1-25', printed_total: 198, set_abbreviation: 'SVI', card_type: 'pokémon' })
    expect(indexes.lookup.setCodes.get('SVI')).toEqual(['sv1'])
    expect(indexes.lookup.setCodes.get('SVP')).toEqual(['svp']) // the promo codes the server adds
    expect(indexes.stats.withTexts).toBe(2)
  })

  it('narrows to the ids of the bundle index files', async () => {
    const { rows } = await loadCatalogueRows(makeStore())
    expect([...buildDecideIndexes(rows, { restrictToIds: ['sv1-28_en', 'unknown_en'] }).candidates.keys()]).toEqual(['sv1-28_en'])
  })

  it('candidateFromRow drops what the server index would not hold', () => {
    expect(candidateFromRow({ id: 'a-1_de', name: 'X', lang: 'de' })).toBeNull()
    expect(candidateFromRow({ id: 'a-1_en', name: '' })).toBeNull()
    expect(candidateFromRow({ id: 'a-1_en', name: 'X', printed_total: 0 }).printed_total).toBeNull()
  })

  it('the chunked build gives the same indexes and yields between chunks', async () => {
    const rows = generateCatalogue(900, 5)
    let yields = 0
    const chunked = await buildDecideIndexesAsync(rows, { chunk: 100, yieldFn: async () => { yields += 1 } })
    expect(yields).toBe(9)
    const whole = buildDecideIndexes(rows)
    expect([...chunked.candidates.keys()]).toEqual([...whole.candidates.keys()])
    expect(chunked.lookup.segments).toEqual(whole.lookup.segments)
    expect([...chunked.names.byKey.keys()]).toEqual([...whole.names.byKey.keys()])
  })

  it('is plain data: a structured clone decides the same (so a worker can build it)', () => {
    const rows = generateCatalogue(600, 9)
    const indexes = buildDecideIndexes(rows)
    const clone = structuredClone(indexes)
    const ids = [...indexes.candidates.keys()]
    const scores = ids.map((_, row) => 0.1 + ((row * 37) % 100) / 400)
    const target = indexes.candidates.get(ids[123])
    scores[123] = 0.91
    const read = { number: target.number, total: String(target.printed_total), tokens: [], lines: [`${target.number}/${target.printed_total}`], name: target.name, hp: null }
    const input = { pictureScores: { ids, scores, art: null }, read, options: { numberOnce: true }, indexes }
    const first = decideCard(input)
    const second = decideCard({ ...input, indexes: clone })
    expect(first.decided).toBe(true)
    expect(second).toEqual(first)
  })
})

describe('createLazyIndexes', () => {
  it('builds once per catalogue signature and shares concurrent builds', async () => {
    let builds = 0
    let hash = 'H1'
    const store = { getMeta: async () => ({ hash, sets: 2 }), scanSets: makeStore().scanSets }
    const get = createLazyIndexes({ source: store, build: async rows => { builds += 1; return buildDecideIndexes(rows) } })
    const [first, second] = await Promise.all([get(), get()])
    expect(first).toBe(second)
    expect(await get()).toBe(first)
    expect(builds).toBe(1)
    hash = 'H2' // a card sync changed the catalogue
    const rebuilt = await get()
    expect(rebuilt).not.toBe(first)
    expect(builds).toBe(2)
  })
})

describe('pictureTopK (the short form)', () => {
  it('averages the two signals where both list a card and uses the one that has it otherwise', () => {
    const { ids, scores, art } = scoresFromTopK({ whole: [{ id: 'a', score: 0.9 }, { id: 'b', score: 0.5 }], art: [{ id: 'a', score: 0.7 }, { id: 'c', score: 0.6 }] })
    expect(ids).toEqual(['a', 'b', 'c'])
    expect(scores[0]).toBeCloseTo(0.8, 12)
    expect(scores.slice(1)).toEqual([0.5, 0.6])
    expect(art).toEqual([0.7, null, 0.6])
  })

  it('decides from the two top lists when the text candidates are already among them', () => {
    const rows = generateCatalogue(300, 2)
    const indexes = buildDecideIndexes(rows)
    const target = rows[42]
    const other = rows[7]
    const result = decideCard({
      pictureTopK: { whole: [{ id: target.id, score: 0.93 }, { id: other.id, score: 0.4 }], art: [{ id: target.id, score: 0.9 }, { id: other.id, score: 0.35 }] },
      read: null, options: {}, indexes,
    })
    expect(result).toMatchObject({ decided: true, cardId: target.id, mechanism: 'picture_lead' })
    expect(result.candidates.map(item => item.id)).toEqual([target.id, other.id])
    expect(result.candidates[0]).toMatchObject({ rank: 1, pictureRank: 1 })
  })
})
