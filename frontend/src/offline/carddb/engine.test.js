import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { createCardDbEngine, signatureOf } from './engine.js'
import { createBackgroundEngine } from './engineClient.js'
import { FIXTURE_PRICES, FIXTURE_SETS, seedBilingualStore, seedStore } from './fixture.js'
import { CARDDB_DB_NAME } from './store.js'

let factory
let store
let engine
beforeEach(async () => {
  factory = new IDBFactory()
  store = await seedStore(factory)
  engine = createCardDbEngine({ store })
})

// A database from before version 2: the derived stores did not exist, so nothing was written to them.
async function emptyDerivedStores() {
  const database = await new Promise((resolve, reject) => {
    const request = factory.open(CARDDB_DB_NAME)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise((resolve, reject) => {
    const tx = database.transaction(['setRows', 'setPrices', 'searchIndex'], 'readwrite')
    for (const name of ['setRows', 'setPrices', 'searchIndex']) tx.objectStore(name).clear()
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
  database.close()
}

describe('card database engine', () => {
  it('writes the set rows when a set is saved, so the sets list needs no card data', async () => {
    const rows = await store.getSetRows('en')
    expect(rows.map(row => row.id).sort()).toEqual(['old_en', 'pbl_en', 'svi_en'])
    const { sets, pricesUpdatedAt } = await engine.sets(['en'])
    expect(sets).toHaveLength(3)
    expect(pricesUpdatedAt).toBe('2026-10-21')
  })

  it('rebuilds the derived records from the stored sets after an upgrade from version 1', async () => {
    await emptyDerivedStores()
    expect(await store.getSetRows('en')).toEqual([])
    const { sets } = await engine.sets(['en'])
    expect(sets.map(set => set.id).sort()).toEqual(['old_en', 'pbl_en', 'svi_en'])
    expect((await store.getSearchIndex('en')).rows).toHaveLength(8)
    const found = await engine.search(['en'], { q: 'Morpeko 117 PBL' })
    expect(found.data.map(card => card.id)).toEqual(['pbl-117_en'])
  })

  it('reads one set from its own payload with that set\'s prices', async () => {
    await engine.prepare(['en'])
    const stored = await store.getSetPrices('en', 'pbl_en')
    expect(stored.rows.map(row => row[0])).toEqual(['pbl-117_en', 'pbl-9_en'])
    const checklist = await engine.checklist(['en'], 'pbl_en')
    expect(checklist.cards.map(card => card.number)).toEqual(['9', '117', '118', '120'])
    expect(checklist.cards.find(card => card.number === '117')).toMatchObject({ price_market: 4.5, price_low: 3.2 })
  })

  it('reads the prices from the whole file for a set that is not derived yet', async () => {
    const checklist = await engine.checklist(['en'], 'pbl_en')
    expect(checklist.cards.find(card => card.number === '9')).toMatchObject({ price_market: 1 })
  })

  it('rebuilds the index when a sync changed the language, and searches the new data', async () => {
    expect((await engine.search(['en'], { q: 'Mew' })).total_count).toBe(1)
    const payload = { ...FIXTURE_SETS.old_en, cards: [...FIXTURE_SETS.old_en.cards, [...FIXTURE_SETS.old_en.cards[0]]] }
    payload.cards[1] = [...payload.cards[1]]
    payload.cards[1][0] = 'old-2_en'
    payload.cards[1][2] = 'Mewtwo'
    payload.cards[1][4] = '2'
    await store.putSet('en', 'old_en', { hash: 'h2', bytes: 10, payload })
    const meta = await store.getMeta('en')
    await store.setMeta('en', { ...meta, syncedAt: 2 })
    expect((await engine.search(['en'], { q: 'Mewtwo' })).data.map(card => card.id)).toEqual(['old-2_en'])
    expect(signatureOf(await store.getMeta('en'))).toBe((await store.getSearchIndex('en')).signature)
  })

  it('removes a deleted set from the derived records', async () => {
    await engine.prepare(['en'])
    await store.deleteSets('en', ['old_en'])
    expect(await store.getSetRows('en')).toHaveLength(2)
    expect(await store.getSetPrices('en', 'old_en')).toBeNull()
  })

  it('finds cards by their effect text without keeping the text in the index', async () => {
    const sets = structuredClone(FIXTURE_SETS)
    const fields = [...sets.pbl_en.fields, 'card_effect']
    sets.pbl_en = { ...sets.pbl_en, fields, cards: sets.pbl_en.cards.map((row, index) => [...row, index === 2 ? 'Draw 3 cards.' : null]) }
    const seeded = await seedStore(new IDBFactory(), { sets })
    const withText = createCardDbEngine({ store: seeded })
    const found = await withText.search(['en'], { rule_text: 'draw 3' })
    expect(found.data.map(card => card.name)).toEqual(['Pikachu'])
    expect((await seeded.getSearchIndex('en')).fields).not.toContain('card_effect')
  })

  it('has the same answers through the background wrapper when no worker can start', async () => {
    const wrapped = createBackgroundEngine({ store, createWorker: () => null })
    expect((await wrapped.search(['en'], { q: 'Morpeko 117 PBL' })).data.map(card => card.id)).toEqual(['pbl-117_en'])
    expect(await wrapped.pricesUpdatedAt(['en'])).toBe(FIXTURE_PRICES.updatedAt)
  })
})

describe('a database in two languages that share catalogue ids (F18)', () => {
  let bilingual
  beforeEach(async () => {
    const both = await seedBilingualStore(new IDBFactory())
    bilingual = createCardDbEngine({ store: both })
  })

  it('opens the Japanese set with its own Japanese cards, not the English set that shares its catalogue id', async () => {
    const ja = await bilingual.checklist(['en', 'ja'], 'pbl_ja')
    expect(ja.set).toMatchObject({ id: 'pbl_ja', lang: 'ja' })
    expect(ja.cards.map(card => card.id)).toEqual(['pbl-9_ja', 'pbl-117_ja', 'pbl-118_ja'])
    expect(ja.cards.every(card => card.lang === 'ja')).toBe(true)
    expect(ja.cards.map(card => card.name)).toEqual(['ピカチュウ', 'モルペコ', 'モルペコ'])
    const en = await bilingual.checklist(['en', 'ja'], 'pbl_en')
    expect(en.cards.map(card => card.id)).toEqual(['pbl-9_en', 'pbl-117_en', 'pbl-118_en', 'pbl-120_en'])
  })

  it('searches inside one language\'s set only, and across languages with the bare catalogue id', async () => {
    const ids = result => result.data.map(card => card.id).sort()
    expect(ids(await bilingual.search(['en', 'ja'], { set_id: 'pbl_ja' }))).toEqual(['pbl-117_ja', 'pbl-118_ja', 'pbl-9_ja'])
    expect(ids(await bilingual.search(['en', 'ja'], { set_id: 'pbl_en' }))).toEqual(['pbl-117_en', 'pbl-118_en', 'pbl-120_en', 'pbl-9_en'])
    expect(ids(await bilingual.search(['en', 'ja'], { set_id: 'pbl' }))).toHaveLength(7)
  })

  it('finds a Japanese-only set and a set whose cards are another language\'s stand-ins, each under its own id', async () => {
    expect((await bilingual.checklist(['en', 'ja'], 'jpo_ja')).cards.map(card => card.id)).toEqual(['jpo-1_ja'])
    expect(await bilingual.checklist(['en'], 'jpo_ja')).toBeNull()
    const borrowed = await bilingual.checklist(['en', 'ja'], 'fbk_ja')
    expect(borrowed.cards.map(card => [card.id, card.lang, card.data_source_lang])).toEqual([
      ['fbk-1_ja', 'ja', 'en'], ['fbk-2_ja', 'ja', 'en'],
    ])
  })

  it('opens a card by its own language id', async () => {
    expect((await bilingual.card(['en', 'ja'], 'pbl-117_ja')).name).toBe('モルペコ')
    expect((await bilingual.card(['en', 'ja'], 'pbl-117_en')).name).toBe('Morpeko')
  })
})
