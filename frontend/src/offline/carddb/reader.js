// Read adapters over the offline card database (F13b). They return the same shapes the pages'
// online queries return, so a page can swap its data source when the app is offline:
//   sets()          -> GET /sets/            (array; series grouping is done by the page)
//   setChecklist()  -> GET /sets/:id/checklist
//   card()          -> GET /cards/:id
//   search()        -> GET /cards/search     ({ data, total_count, page, page_size, corrected? })
// Prices come from the downloaded prices file and `pricesUpdatedAt` says how old they are.
// Nothing here throws: a missing or switched-off database resolves to `null` / empty, so the
// caller keeps F12's behaviour (a saved copy, or the "not saved yet" line).

import { createCardDbStore } from './store.js'
import { createCardDbEngine, setRef } from './engine.js'

/** Owned counts per (tcg set id|lang) and the exact items per card, built from a cached collection. */
export function ownedIndexFromCollection(items) {
  const byCard = new Map()
  for (const item of items ?? []) {
    const cardId = item.card_id ?? item.card?.id
    if (!cardId) continue
    if (!byCard.has(cardId)) byCard.set(cardId, [])
    byCard.get(cardId).push(item)
  }
  return byCard
}

export function createCardDbReader({ store = createCardDbStore(), isEnabled = () => true, engine = null } = {}) {
  // The engine does the reading (in a Web Worker in the app); this reader shapes its answers.
  const db = engine ?? createCardDbEngine({ store })

  async function languages(wanted) {
    if (!isEnabled()) return []
    const stored = await store.listLanguages()
    if (!wanted || wanted === 'all') return stored
    return stored.includes(wanted) ? [wanted] : []
  }

  return {
    /** Whether any card data is stored (and the feature is on). */
    hasData: async () => (await languages('all')).length > 0,

    /** The newest prices date among the stored languages, or null. */
    pricesUpdatedAt: async wanted => db.pricesUpdatedAt(await languages(wanted)),

    /** Builds the engine's derived records now (idle time after a sync), so the first query is quick. */
    prepare: async () => db.prepare(await languages('all')),

    /** The sets list, newest first. `ownedCounts` maps "<tcg set id>|<lang>" to a distinct owned count. */
    async sets({ lang = 'all', ownedCounts = null } = {}) {
      const { sets } = await db.sets(await languages(lang))
      if (!sets.length) return null
      return sets
        .map(set => ({
          ...set,
          // null = unknown (the collection was never loaded): a wrong zero would read as "you own none"
          owned_count: ownedCounts ? (ownedCounts.get(`${set.tcg_set_id || set.id}|${set.lang}`) ?? 0) : null,
        }))
        .sort((a, b) => {
          if (!a.release_date && !b.release_date) return 0
          if (!a.release_date) return 1
          if (!b.release_date) return -1
          return a.release_date < b.release_date ? 1 : a.release_date > b.release_date ? -1 : 0
        })
    },

    /** One set row, or null. */
    async set(setId) {
      const found = await db.checklist(await languages('all'), setId)
      return found?.set ?? null
    },

    /** The set checklist; `ownedByCard` (Map cardId -> collection items) fills the owned state. */
    async setChecklist(setId, { ownedByCard = null, wishlistedIds = null } = {}) {
      const found = await db.checklist(await languages('all'), setId)
      if (!found) return null
      const { set, cards: rows, pricesUpdatedAt } = found
      const checklist = rows.map(card => {
        const items = ownedByCard?.get(card.id) ?? []
        const quantity = items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
        return {
          id: card.id,
          name: card.name,
          tcg_card_id: card.tcg_card_id,
          set_id: card.set_id,
          set_ref: setRef(set),
          number: card.number,
          rarity: card.rarity,
          images_small: card.images_small,
          images_large: card.images_large,
          image_source_lang: card.image_source_lang,
          data_source_lang: card.data_source_lang,
          owned: quantity > 0,
          owned_quantity: quantity,
          owned_variants: [...new Set(items.map(item => item.variant).filter(Boolean))],
          wishlisted: Boolean(wishlistedIds?.has(card.id)),
          quantity,
          owned_items: items,
          price_market: card.price_market ?? null,
          price_low: card.price_low ?? null,
          price_trend: card.price_trend ?? null,
          price_avg1: card.price_avg1 ?? null,
          price_avg7: card.price_avg7 ?? null,
          price_avg30: card.price_avg30 ?? null,
          price_market_holo: card.price_market_holo ?? null,
          price_low_holo: card.price_low_holo ?? null,
          price_trend_holo: card.price_trend_holo ?? null,
          price_avg1_holo: card.price_avg1_holo ?? null,
          price_avg7_holo: card.price_avg7_holo ?? null,
          price_avg30_holo: card.price_avg30_holo ?? null,
          dex_ids: card.dex_ids,
          pokedex_entry_ids: card.pokedex_entry_ids,
          cardmarket_products: card.cardmarket_products,
          variants_normal: card.variants_normal,
          variants_reverse: card.variants_reverse,
          variants_holo: card.variants_holo,
          variants_first_edition: card.variants_first_edition,
          lang: card.lang || 'en',
        }
      })
      const ownedCount = checklist.filter(card => card.owned).length
      const ownedUnknown = !ownedByCard
      return {
        set: {
          id: set.id,
          name: set.name,
          series: set.series,
          total: set.total,
          images_symbol: set.images_symbol,
          images_logo: set.images_logo,
          lang: set.lang || 'en',
        },
        cards: checklist,
        owned_count: ownedUnknown ? null : ownedCount,
        total_count: checklist.length,
        progress: checklist.length ? Math.round((ownedCount / checklist.length) * 1000) / 10 : 0,
        owned_unknown: ownedUnknown,
        pricesUpdatedAt,
      }
    },

    /** Card detail (GET /cards/:id), or null when the card is not in the downloaded data. */
    async card(cardId) {
      return db.card(await languages('all'), cardId)
    },

    /** The smart search; same params and envelope as GET /cards/search. */
    async search(params = {}) {
      return db.search(await languages(params.lang && params.lang !== 'all' ? params.lang : 'all'), params)
    },
  }
}
