// The card database's query engine (F14a). It answers the reader's questions from small, derived
// records instead of decoding every downloaded card:
//   setRows     one small row per set                      -> the sets list, set lookups
//   setPrices   the prices of one set                      -> a set page reads one payload + these
//   searchIndex one compact record per language            -> search and card lookups
// The derived records are rebuilt from the stored sets whenever the language's sync signature
// changes (or they are missing, e.g. after upgrading from database version 1). The engine is plain
// code over an injected store: the app runs it in a Web Worker (engineClient.js) so the heavy
// first load never blocks the main thread, and tests run it inline.

import { compareNumbers, matchesRuleText, searchCardsOffline, stripDiacritics, buildNameLists, buildSetIndex } from './search.js'

// What a search needs per card; long texts (attacks, abilities, effects) stay in the set payloads.
export const INDEX_FIELDS = [
  'id', 'name', 'nameKey', 'set_id', 'number', 'lang', 'supertype', 'types', 'rarity', 'hp', 'artist', 'dex_ids',
  'trainer_type', 'energy_type', 'stage', 'suffix', 'subtypes', 'price_market', 'price_low',
]

export const signatureOf = meta => `${meta.hash}|${meta.pricesHash}|${meta.syncedAt}`

export function setRef(set) {
  return { id: set.id, tcg_set_id: set.tcg_set_id, name: set.name, abbreviation: set.abbreviation, lang: set.lang }
}

function decodeCard(fields, row, prices, lang) {
  const card = {}
  fields.forEach((field, index) => { card[field] = row[index] })
  card.localId = card.number
  card.lang = card.lang || lang
  card.is_custom = false
  card.is_digital = card.is_digital || false
  Object.assign(card, prices.get(card.id) ?? {})
  return card
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

const langOfId = id => {
  const at = String(id).lastIndexOf('_')
  return at > 0 ? String(id).slice(at + 1) : null
}

export function createCardDbEngine({ store }) {
  const loaded = new Map() // lang -> { signature, promise of { sets, cards, byId, setByTcg, pricesUpdatedAt } }
  const building = new Map() // lang -> Promise<index record>
  const combined = new Map() // signatures key -> prepared search helpers

  async function build(lang, meta) {
    const signature = signatureOf(meta)
    const prices = await store.getPrices(lang)
    const priceRowById = new Map((prices?.rows ?? []).map(row => [row[0], row]))
    const priceById = priceMap(prices)
    const rows = []
    const setRows = []
    const setPriceEntries = []
    await store.scanSets(lang, payload => {
      if (!payload?.set) return
      setRows.push({ ...payload.set, lang: payload.set.lang || lang })
      const fields = payload.fields ?? []
      const owned = []
      for (const row of payload.cards ?? []) {
        const card = decodeCard(fields, row, priceById, lang)
        card.nameKey = stripDiacritics(card.name)
        rows.push(INDEX_FIELDS.map(field => card[field] ?? null))
        const priceRow = priceRowById.get(card.id)
        if (priceRow) owned.push(priceRow)
      }
      setPriceEntries.push([payload.set.id, { signature, fields: prices?.fields ?? [], rows: owned }])
    })
    await store.putSetRows(lang, setRows)
    await store.putSetPrices(lang, setPriceEntries)
    const record = { signature, fields: INDEX_FIELDS, rows, pricesUpdatedAt: prices?.updatedAt ?? meta.pricesUpdatedAt ?? null }
    await store.putSearchIndex(lang, record)
    return record
  }

  /** The derived records of a language, rebuilt when missing or stale (one build at a time). */
  function ensureIndex(lang, meta) {
    if (!building.has(lang)) {
      const job = (async () => {
        const record = await store.getSearchIndex(lang)
        if (record?.signature === signatureOf(meta)) return record
        return build(lang, meta)
      })()
      building.set(lang, job)
      const clear = () => { if (building.get(lang) === job) building.delete(lang) }
      job.then(clear, clear)
    }
    return building.get(lang)
  }

  async function setRowsOf(lang) {
    const meta = await store.getMeta(lang)
    if (!meta) return []
    const stored = await store.getSetRows(lang)
    const expected = (await store.listSetHashes(lang)).size
    if (stored.length >= expected && stored.length > 0) return stored
    await ensureIndex(lang, meta)
    return store.getSetRows(lang)
  }

  async function create(lang, meta, signature) {
    const record = await ensureIndex(lang, meta)
    const sets = await setRowsOf(lang)
    const fields = record.fields
    const cards = record.rows.map(row => {
      const card = {}
      for (let index = 0; index < fields.length; index += 1) card[fields[index]] = row[index]
      card.localId = card.number
      return card
    })
    return {
      signature,
      lang,
      sets,
      cards,
      byId: new Map(cards.map(card => [card.id, card])),
      setByTcg: new Map(sets.map(set => [`${set.tcg_set_id || set.id}|${set.lang}`, set])),
      pricesUpdatedAt: record.pricesUpdatedAt ?? meta.pricesUpdatedAt ?? null,
    }
  }

  /** The language in memory (index rows as objects), reloaded when a sync changed it; null without data. */
  async function load(lang) {
    const meta = await store.getMeta(lang)
    if (!meta) {
      loaded.delete(lang)
      return null
    }
    const signature = signatureOf(meta)
    const cached = loaded.get(lang)
    if (cached?.signature === signature) return cached.promise
    const slot = { signature, promise: create(lang, meta, signature) }
    loaded.set(lang, slot)
    slot.promise.catch(() => { if (loaded.get(lang) === slot) loaded.delete(lang) })
    return slot.promise
  }

  async function pricesOfSet(lang, setId, signature) {
    const record = await store.getSetPrices(lang, setId)
    if (record && record.signature === signature) return priceMap(record)
    return priceMap(await store.getPrices(lang))
  }

  /** Full card objects (as the pages expect) for index rows, in the given order. */
  async function hydrate(entries, indexRows) {
    const bySet = new Map()
    for (const row of indexRows) {
      const entry = entries.find(item => item.lang === row.lang)
      const set = entry?.setByTcg.get(`${row.set_id}|${row.lang}`)
      if (!entry || !set) continue
      const key = `${row.lang}|${set.id}`
      if (!bySet.has(key)) bySet.set(key, { entry, set, ids: new Set() })
      bySet.get(key).ids.add(row.id)
    }
    const found = new Map()
    for (const { entry, set, ids } of bySet.values()) {
      const payload = await store.getSet(entry.lang, set.id)
      if (!payload) continue
      const prices = await pricesOfSet(entry.lang, set.id, entry.signature)
      const fields = payload.fields ?? []
      const idAt = fields.indexOf('id')
      for (const row of payload.cards ?? []) {
        if (!ids.has(row[idAt])) continue
        const card = decodeCard(fields, row, prices, entry.lang)
        found.set(card.id, { ...card, set_ref: setRef(set) })
      }
    }
    return indexRows.map(row => found.get(row.id)).filter(Boolean)
  }

  async function entriesFor(langs) {
    return (await Promise.all(langs.map(load))).filter(Boolean)
  }

  function preparedFor(entries) {
    const key = entries.map(entry => `${entry.lang}:${entry.signature}`).join(',')
    if (!combined.has(key)) {
      combined.clear()
      const sets = entries.flatMap(entry => entry.sets)
      const cards = entries.length === 1 ? entries[0].cards : entries.flatMap(entry => entry.cards)
      const setByKey = new Map()
      for (const item of sets) {
        setByKey.set(item.id, item)
        if (item.tcg_set_id) setByKey.set(item.tcg_set_id, item)
      }
      combined.set(key, { sets, cards, prepared: { index: buildSetIndex(sets), lists: buildNameLists(cards), setByKey } })
    }
    return combined.get(key)
  }

  const newest = values => values.filter(Boolean).sort().at(-1) ?? null

  return {
    /** Set rows (no owned counts) of the given languages, and the newest prices date. */
    async sets(langs) {
      const sets = []
      const dates = []
      for (const lang of langs) {
        const meta = await store.getMeta(lang)
        if (!meta) continue
        sets.push(...await setRowsOf(lang))
        dates.push(meta.pricesUpdatedAt)
      }
      return { sets, pricesUpdatedAt: newest(dates) }
    },

    /** The newest prices date among the languages. */
    async pricesUpdatedAt(langs) {
      const dates = []
      for (const lang of langs) dates.push((await store.getMeta(lang))?.pricesUpdatedAt)
      return newest(dates)
    },

    /** One set with its decoded, number-ordered cards (prices included), or null. */
    async checklist(langs, setId) {
      const hint = langOfId(setId)
      for (const lang of [...new Set([hint, ...langs].filter(item => langs.includes(item)))]) {
        const meta = await store.getMeta(lang)
        if (!meta) continue
        const set = (await setRowsOf(lang)).find(item => item.id === setId)
        if (!set) continue
        const payload = await store.getSet(lang, set.id)
        if (!payload) continue
        const prices = await pricesOfSet(lang, set.id, signatureOf(meta))
        const fields = payload.fields ?? []
        const tcgId = set.tcg_set_id || set.id
        const cards = (payload.cards ?? [])
          .map(row => decodeCard(fields, row, prices, lang))
          .filter(card => card.set_id === tcgId && card.lang === set.lang)
          .sort((a, b) => compareNumbers(a.number, b.number))
        return { set, cards, pricesUpdatedAt: meta.pricesUpdatedAt ?? null }
      }
      return null
    },

    /** One full card with its set reference, or null. */
    async card(langs, cardId) {
      const hint = langOfId(cardId)
      for (const lang of [...new Set([hint, ...langs].filter(Boolean))]) {
        if (!langs.includes(lang)) continue
        const entry = await load(lang)
        const row = entry?.byId.get(cardId)
        if (!row) continue
        const [card] = await hydrate([entry], [row])
        if (card) return { ...card, set_ref: card.set_ref ?? null, pricesUpdatedAt: entry.pricesUpdatedAt }
      }
      return null
    },

    /** The smart search; same params and envelope as GET /cards/search (null when no cards). */
    async search(langs, params = {}) {
      const entries = await entriesFor(langs)
      const { sets, cards, prepared } = preparedFor(entries)
      if (!cards.length) return null
      let pool = cards
      let searchParams = params
      if (params.rule_text && String(params.rule_text).trim()) {
        // The long texts are not in the index: scan the stored sets for them, one set at a time.
        const term = String(params.rule_text)
        const ids = new Set()
        for (const entry of entries) {
          await store.scanSets(entry.lang, payload => {
            const fields = payload.fields ?? []
            for (const row of payload.cards ?? []) {
              const card = {}
              fields.forEach((field, index) => { card[field] = row[index] })
              if (matchesRuleText(card, term)) ids.add(card.id)
            }
          })
        }
        pool = cards.filter(card => ids.has(card.id))
        const { rule_text: ignored, ...rest } = params
        searchParams = rest
      }
      const result = searchCardsOffline({ cards: pool, sets, params: searchParams, prepared })
      result.data = await hydrate(entries, result.data)
      result.pricesUpdatedAt = newest(entries.map(entry => entry.pricesUpdatedAt))
      return result
    },

    /** Builds (or loads) everything for the languages so the first real query is fast. */
    async prepare(langs) {
      for (const lang of langs) {
        await setRowsOf(lang)
        await load(lang)
      }
      return true
    },
  }
}
