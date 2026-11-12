// The catalogue adapter: turns the phone's offline card database (frontend/src/offline/carddb) into the indexes the
// decision needs (candidate rows, the name index and the lookup index), and nothing else. See docs/phone-scanner/decide.md.
//
// Card ids. carddb stores the server's own card ids ("sv1-1_en", the `card.id` column), and the phone bundle's index
// files carry the same ids (`phone.pack_index` writes `entries` ids). So the mapping is the identity; the adapter
// only filters to the cards the server indexes: English, physical (not digital-only), with a catalogue picture, with a
// name. ``restrictToIds`` (the ids of the bundle's index files) narrows it further to exactly the indexed cards.

import { cardTexts, createLookupBuilder } from './lookup.js'
import { buildNameIndex } from './names.js'

export const INDEXES_VERSION = 1

const tcgIdOf = id => (String(id).includes('_') ? String(id).slice(0, String(id).lastIndexOf('_')) : String(id))
const toList = value => {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/**
 * One catalogue row is the card joined with its set:
 * {id, tcg_card_id, name, number, set_id, set_name, set_abbreviation, printed_total, rarity, hp, artist, regulation_mark,
 *  suffix, supertype, card_effect, attacks, abilities, lang, is_digital, images_small}
 * Returns the candidate row the ranking rules read (the server's ``db_candidate_loader`` shape), or null when the server's
 * index would not hold the card.
 */
export function candidateFromRow(row) {
  if (!row || !row.id || !row.name) return null
  const lang = row.lang || (String(row.id).includes('_') ? String(row.id).slice(String(row.id).lastIndexOf('_') + 1) : 'en')
  if (lang !== 'en' || row.is_digital) return null
  if (row.images_small !== undefined && !row.images_small) return null // a card with no catalogue picture is not in the picture index
  const printed = Number(row.printed_total) || null
  return {
    id: row.tcg_card_id || tcgIdOf(row.id),
    tcg_card_id: row.tcg_card_id || tcgIdOf(row.id),
    name: row.name,
    number: row.number ?? null,
    hp: row.hp ?? null,
    artist: row.artist ?? null,
    regulation_mark: row.regulation_mark ?? null,
    card_type: String(row.supertype || '').toLowerCase() || null,
    set: row.set_name ?? null,
    set_abbreviation: row.set_abbreviation ?? null,
    printed_total: printed,
    _lang: lang,
    rarity: row.rarity ?? null,
  }
}

/** Builds the indexes in one go. Pure: a plain array in, plain data out. For a UI thread use ``buildDecideIndexesAsync`` or a worker. */
export function buildDecideIndexes(catalogueRows, { restrictToIds = null } = {}) {
  const builder = startBuild(restrictToIds)
  for (const row of catalogueRows) builder.add(row)
  return builder.finish()
}

/** The same, feeding rows in chunks and yielding to the event loop between them, so the UI keeps painting. */
export async function buildDecideIndexesAsync(catalogueRows, { restrictToIds = null, chunk = 1500, yieldFn = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
  const builder = startBuild(restrictToIds)
  for (let start = 0; start < catalogueRows.length; start += chunk) {
    for (let index = start; index < Math.min(catalogueRows.length, start + chunk); index += 1) builder.add(catalogueRows[index])
    await yieldFn()
  }
  return builder.finish()
}

function startBuild(restrictToIds) {
  const allowed = restrictToIds ? new Set(restrictToIds) : null
  const candidates = new Map()
  const nameRows = []
  const sets = new Map() // tcg set id -> abbreviation
  const lookupSetCodes = new Map()
  const lookup = createLookupBuilder({})
  const stats = { rows: 0, kept: 0, skipped: 0, printedTotalMissing: 0, withTexts: 0 }
  const startedAt = Date.now()

  function add(row) {
    stats.rows += 1
    const candidate = candidateFromRow(row)
    if (!candidate || (allowed && !allowed.has(row.id))) {
      stats.skipped += 1
      return
    }
    stats.kept += 1
    if (!candidate.printed_total) stats.printedTotalMissing += 1
    candidates.set(row.id, candidate)
    const printed = candidate.printed_total ? String(candidate.printed_total) : null
    nameRows.push({ card_id: row.id, name: row.name, number: row.number ?? null, printed_total: printed })
    const attacks = toList(row.attacks) ?? []
    const abilities = toList(row.abilities) ?? []
    const texts = cardTexts(row.card_effect, attacks, abilities)
    if (texts.length) stats.withTexts += 1
    lookup.add({ card_id: row.id, name: row.name, number: row.number ?? null, printed_total: printed, set_id: row.set_id ?? null, suffix: row.suffix ?? null, texts })
    if (row.set_id && !sets.has(row.set_id)) sets.set(row.set_id, row.set_abbreviation ?? null)
  }

  function finish() {
    // Printed set codes come from the sets table: its abbreviation and its TCGdex set id, both pointing at the set id.
    for (const [setId, abbreviation] of sets) {
      for (const code of [abbreviation, setId]) {
        if (!code) continue
        const key = String(code).toUpperCase()
        if (!lookupSetCodes.has(key)) lookupSetCodes.set(key, new Set())
        lookupSetCodes.get(key).add(setId)
      }
    }
    const lookupIndex = lookup.finish()
    // The set codes are known only now: give them to the finished index (the builder was started with none).
    for (const [code, ids] of lookupSetCodes) {
      const merged = new Set(lookupIndex.setCodes.get(code) ?? [])
      for (const id of ids) merged.add(id)
      lookupIndex.setCodes.set(code, [...merged])
    }
    stats.buildMs = Date.now() - startedAt
    stats.distinctNames = 0
    const names = buildNameIndex(nameRows)
    stats.distinctNames = names.byKey.size
    stats.segments = lookupIndex.segments.length
    return { version: INDEXES_VERSION, count: candidates.size, candidates, names, lookup: lookupIndex, stats }
  }

  return { add, finish }
}

// ── reading the phone's own card database ───────────────────────────────────

/** The signature the indexes are valid for: carddb's catalogue hash for the language (prices do not change them). */
export const catalogueSignature = meta => (meta ? `${meta.hash}|${meta.sets ?? ''}` : null)

function joinRow(card, set, fields) {
  const at = name => (fields.indexOf(name) >= 0 ? card[fields.indexOf(name)] : undefined)
  return {
    id: at('id'),
    tcg_card_id: at('tcg_card_id'),
    name: at('name'),
    number: at('number'),
    set_id: at('set_id'),
    set_name: set?.name ?? null,
    set_abbreviation: set?.abbreviation ?? null,
    // carddb's set rows do not carry `printed_total` yet (see docs/phone-scanner/decide.md: needed carddb change).
    printed_total: set?.printed_total ?? null,
    rarity: at('rarity'),
    hp: at('hp'),
    artist: at('artist'),
    regulation_mark: at('regulation_mark'),
    suffix: at('suffix'),
    supertype: at('supertype'),
    card_effect: at('card_effect'),
    attacks: at('attacks'),
    abilities: at('abilities'),
    lang: at('lang'),
    is_digital: Boolean(at('is_digital') || set?.is_digital),
    images_small: at('images_small'),
  }
}

/**
 * Reads the English catalogue rows from the phone's card database. ``source`` is carddb's store
 * (``createCardDbStore()``: ``getMeta`` and ``scanSets``, both existing carddb functions) or an object with a ``store``
 * property holding one (carddb's reader/engine wrappers do not expose the long texts, which only the stored set payloads
 * hold). Reads one stored set at a time, so the whole language is never decoded twice. Returns
 * ``{rows, signature, printedTotalMissing}``; ``signature`` is null when no English data is stored.
 *
 * ``totalFallback``: 'none' (default) leaves the printed total unknown when the set row has no ``printed_total``;
 * 'total' uses the set's ``total`` (which counts secret rares, so it is wrong for sets that have them).
 */
export async function loadCatalogueRows(source, { lang = 'en', totalFallback = 'none' } = {}) {
  const store = source?.scanSets ? source : source?.store
  if (!store?.scanSets || !store?.getMeta) throw new Error('loadCatalogueRows needs the card database store (getMeta and scanSets)')
  const meta = await store.getMeta(lang)
  if (!meta) return { rows: [], signature: null, printedTotalMissing: 0 }
  const rows = []
  let missing = 0
  await store.scanSets(lang, payload => {
    if (!payload?.set) return
    const set = { ...payload.set }
    if ((set.printed_total === undefined || set.printed_total === null) && totalFallback === 'total') set.printed_total = set.total
    if (!set.printed_total) missing += (payload.cards ?? []).length
    const fields = payload.fields ?? []
    for (const card of payload.cards ?? []) rows.push(joinRow(card, set, fields))
  })
  return { rows, signature: catalogueSignature(meta), printedTotalMissing: missing }
}

// ── building lazily, once per catalogue signature ───────────────────────────

/**
 * ``const get = createLazyIndexes({ source, restrictToIds })``; ``await get()`` builds on the first call and again only when
 * the catalogue signature changed (a card sync). Concurrent calls share one build. Rebuilds yield between chunks.
 */
export function createLazyIndexes({ source, restrictToIds = null, build = buildDecideIndexesAsync, load = loadCatalogueRows, options = {} }) {
  let cached = null
  let pending = null
  return async function getIndexes() {
    if (pending) return pending
    pending = (async () => {
      const meta = await source.getMeta?.(options.lang ?? 'en') ?? (source.store ? await source.store.getMeta(options.lang ?? 'en') : null)
      const signature = catalogueSignature(meta)
      if (cached && cached.signature === signature && signature !== null) return cached.indexes
      const { rows, signature: readSignature } = await load(source, options)
      const indexes = await build(rows, { restrictToIds })
      cached = { signature: readSignature, indexes }
      return indexes
    })()
    try {
      return await pending
    } finally {
      pending = null
    }
  }
}
