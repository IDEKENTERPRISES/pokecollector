import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it } from 'vitest'
import { FIXTURE_PRICES, seedStore } from './fixture.js'
import { createCardDbReader, ownedIndexFromCollection } from './reader.js'
import { createCardDbStore } from './store.js'

let reader
beforeEach(async () => {
  reader = createCardDbReader({ store: await seedStore(new IDBFactory()) })
})

describe('card database reader', () => {
  it('lists sets newest first, undated last, with owned counts', async () => {
    const sets = await reader.sets({ ownedCounts: new Map([['pbl|en', 2]]) })
    expect(sets.map(set => set.id)).toEqual(['pbl_en', 'svi_en', 'old_en'])
    expect(sets[0]).toMatchObject({ name: 'Perilous Bloom', series: 'Scarlet & Violet', owned_count: 2, lang: 'en' })
    expect(sets[1].owned_count).toBe(0)
  })

  it('reports owned figures as unknown, not zero, when the collection is not available', async () => {
    const sets = await reader.sets()
    expect(sets.every(set => set.owned_count === null)).toBe(true)
    const list = await reader.setChecklist('pbl_en')
    expect(list).toMatchObject({ owned_unknown: true, owned_count: null })
    const known = await reader.setChecklist('pbl_en', { ownedByCard: new Map() })
    expect(known).toMatchObject({ owned_unknown: false, owned_count: 0, progress: 0 })
  })

  it('returns a checklist in the online shape, in natural number order, with prices', async () => {
    const list = await reader.setChecklist('pbl_en')
    expect(list.cards.map(card => card.number)).toEqual(['9', '117', '118', '120'])
    expect(list).toMatchObject({ total_count: 4, pricesUpdatedAt: '2026-10-21' })
    expect(list.set).toMatchObject({ id: 'pbl_en', name: 'Perilous Bloom', lang: 'en' })
    expect(list.cards.find(card => card.number === '117')).toMatchObject({ price_market: 4.5, price_low: 3.2, owned: false, set_ref: { abbreviation: 'PBL' } })
  })

  it('marks the owned state from the cached collection', async () => {
    const owned = ownedIndexFromCollection([{ card_id: 'pbl-117_en', quantity: 2, variant: 'holo' }, { card_id: 'pbl-9_en', quantity: 1 }])
    const list = await reader.setChecklist('pbl_en', { ownedByCard: owned })
    expect(list).toMatchObject({ owned_count: 2, progress: 50 })
    expect(list.cards.find(card => card.number === '117')).toMatchObject({ owned: true, owned_quantity: 2, owned_variants: ['holo'] })
  })

  it('finds a card by id, and a missing one gives null', async () => {
    expect(await reader.card('pbl-117_en')).toMatchObject({ name: 'Morpeko', localId: '117', price_market: 4.5, set_ref: { id: 'pbl_en' } })
    expect(await reader.card('nope-1_en')).toBeNull()
  })

  it('searches like the server and reports the prices date', async () => {
    const result = await reader.search({ q: 'Morpeko 117 PBL' })
    expect(result.data.map(card => card.id)).toEqual(['pbl-117_en'])
    expect(result.pricesUpdatedAt).toBe('2026-10-21')
    expect((await reader.search({ q: 'Morbeko' })).corrected).toEqual({ from: 'Morbeko', to: 'Morpeko' })
  })

  it('answers null when nothing is downloaded or the feature is switched off', async () => {
    const empty = createCardDbReader({ store: createCardDbStore(new IDBFactory()) })
    expect(await empty.sets()).toBeNull()
    expect(await empty.setChecklist('pbl_en')).toBeNull()
    expect(await empty.search({ q: 'Morpeko' })).toBeNull()
    expect(await empty.hasData()).toBe(false)
    const off = createCardDbReader({ store: await seedStore(new IDBFactory()), isEnabled: () => false })
    expect(await off.sets()).toBeNull()
  })

  it('picks up a newer sync', async () => {
    const store = await seedStore(new IDBFactory())
    const live = createCardDbReader({ store })
    expect((await live.card('pbl-117_en')).price_market).toBe(4.5)
    await store.putPrices('en', { ...FIXTURE_PRICES, hash: 'P2', rows: [['pbl-117_en', 9, 8]] })
    await store.setMeta('en', { hash: 'L1', pricesHash: 'P2', syncedAt: 2 })
    expect((await live.card('pbl-117_en')).price_market).toBe(9)
  })
})
