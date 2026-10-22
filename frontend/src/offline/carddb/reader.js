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
import { compareNumbers, searchCardsOffline } from './search.js'

const langOfSetId = setId => {
  const at = String(setId).lastIndexOf('_')
  return at > 0 ? String(setId).slice(at + 1) : null
}
const langOfCardId = cardId => {
  const at = String(cardId).lastIndexOf('_')
  return at > 0 ? String(cardId).slice(at + 1) : null
}

function decodeCards(payload, prices, lang) {
  const fields = payload?.fields ?? []
  const cards = []
  for (const row of payload?.cards ?? []) {
    const card = {}
    fields.forEach((field, index) => { card[field] = row[index] })
    card.localId = card.number
    card.lang = card.lang || lang
    card.is_custom = false
    card.is_digital = card.is_digital || false
    Object.assign(card, prices.get(card.id) ?? {})
    cards.push(card)
  }
  return cards
}

function priceMap(prices) {
  const map = new Map()
  const fields = prices?.fields ?? []
  for (const row of prices?.rows ?? []) {
    const values = {}
    fields.forEach((field, index) => { values[field] = row[index + 1] })
    map.set(row[0], values)
  }
  return map
}

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

export function createCardDbReader({ store = createCardDbStore(), isEnabled = () => true } = {}) {
  const loaded = new Map() // lang -> { signature, sets, cards, byId, pricesUpdatedAt }

  async function language(lang) {
    const meta = await store.getMeta(lang)
    if (!meta) return null
    const signature = `${meta.hash}|${meta.pricesHash}|${meta.syncedAt}`
    const cached = loaded.get(lang)
    if (cached?.signature === signature) return cached
    const [payloads, prices] = await Promise.all([store.getAllSets(lang), store.getPrices(lang)])
    const prepared = priceMap(prices)
    const sets = []
    const cards = []
    for (const payload of payloads) {
      if (!payload?.set) continue
      sets.push({ ...payload.set, lang: payload.set.lang || lang })
      cards.push(...decodeCards(payload, prepared, lang))
    }
    const entry = {
      signature,
      sets,
      cards,
      byId: new Map(cards.map(card => [card.id, card])),
      pricesUpdatedAt: prices?.updatedAt ?? meta.pricesUpdatedAt ?? null,
    }
    loaded.set(lang, entry)
    return entry
  }

  async function languages(wanted) {
    if (!isEnabled()) return []
    const stored = await store.listLanguages()
    if (!wanted || wanted === 'all') return stored
    return stored.includes(wanted) ? [wanted] : []
  }

  async function catalogue(wanted) {
    const entries = (await Promise.all((await languages(wanted)).map(language))).filter(Boolean)
    return {
      entries,
      sets: entries.flatMap(entry => entry.sets),
      cards: entries.flatMap(entry => entry.cards),
      pricesUpdatedAt: entries.map(entry => entry.pricesUpdatedAt).filter(Boolean).sort().at(-1) ?? null,
    }
  }

  const setRef = set => ({ id: set.id, tcg_set_id: set.tcg_set_id, name: set.name, abbreviation: set.abbreviation, lang: set.lang })

  return {
    /** Whether any card data is stored (and the feature is on). */
    hasData: async () => (await languages('all')).length > 0,

    /** The newest prices date among the stored languages, or null. */
    pricesUpdatedAt: async wanted => (await catalogue(wanted)).pricesUpdatedAt,

    /** The sets list, newest first. `ownedCounts` maps "<tcg set id>|<lang>" to a distinct owned count. */
    async sets({ lang = 'all', ownedCounts = null } = {}) {
      const { sets } = await catalogue(lang)
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
      const sets = await this.sets({ lang: langOfSetId(setId) || 'all' }) ?? await this.sets({ lang: 'all' })
      return sets?.find(set => set.id === setId) ?? null
    },

    /** The set checklist; `ownedByCard` (Map cardId -> collection items) fills the owned state. */
    async setChecklist(setId, { ownedByCard = null, wishlistedIds = null } = {}) {
      const { sets, cards, pricesUpdatedAt } = await catalogue('all')
      const set = sets.find(item => item.id === setId)
      if (!set) return null
      const tcgId = set.tcg_set_id || set.id
      const rows = cards
        .filter(card => card.set_id === tcgId && card.lang === set.lang)
        .sort((a, b) => compareNumbers(a.number, b.number))
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
      const hint = langOfCardId(cardId)
      const order = [...new Set([hint, ...(await languages('all'))].filter(Boolean))]
      for (const lang of order) {
        const entry = await language(lang)
        const card = entry?.byId.get(cardId)
        if (!card) continue
        const set = entry.sets.find(item => (item.tcg_set_id || item.id) === card.set_id)
        return { ...card, set_ref: set ? setRef(set) : null, pricesUpdatedAt: entry.pricesUpdatedAt }
      }
      return null
    },

    /** The smart search; same params and envelope as GET /cards/search. */
    async search(params = {}) {
      const { sets, cards, pricesUpdatedAt } = await catalogue(params.lang && params.lang !== 'all' ? params.lang : 'all')
      if (!cards.length) return null
      const setsByTcg = new Map(sets.map(set => [`${set.tcg_set_id || set.id}|${set.lang}`, set]))
      const result = searchCardsOffline({ cards, sets, params })
      result.data = result.data.map(card => {
        const set = setsByTcg.get(`${card.set_id}|${card.lang}`)
        return { ...card, set_ref: set ? setRef(set) : null }
      })
      result.pricesUpdatedAt = pricesUpdatedAt
      return result
    },
  }
}
