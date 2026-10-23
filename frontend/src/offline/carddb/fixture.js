// A small card database in the downloaded format (F13a payloads), shared by the F13b tests.
import { createCardDbStore } from './store.js'

const FIELDS = ['id', 'tcg_card_id', 'name', 'set_id', 'number', 'rarity', 'supertype', 'hp', 'types', 'dex_ids', 'images_small', 'lang']
const setRow = (id, tcg, name, abbreviation, series, release, lang = 'en') => ({
  id, tcg_set_id: tcg, name, series, series_id: series.toLowerCase(), abbreviation, release_date: release, total: 3, lang,
})
const card = (tcg, number, name, supertype = 'Pokémon', lang = 'en', rarity = 'Common') => [
  `${tcg}-${number}_${lang}`, `${tcg}-${number}`, name, tcg, number, rarity, supertype, '70', ['Lightning'], [877], null, lang,
]

export const FIXTURE_SETS = {
  pbl_en: { v: 1, set: setRow('pbl_en', 'pbl', 'Perilous Bloom', 'PBL', 'Scarlet & Violet', '2026-08-01'), fields: FIELDS, cards: [
    card('pbl', '117', 'Morpeko'), card('pbl', '118', 'Morpeko'), card('pbl', '9', 'Pikachu'), card('pbl', '120', 'Poké Ball', 'Trainer'),
  ] },
  svi_en: { v: 1, set: setRow('svi_en', 'sv1', 'Scarlet & Violet', 'SVI', 'Scarlet & Violet', '2023-03-31'), fields: FIELDS, cards: [
    card('sv1', '117', 'Morpeko'), card('sv1', '2', 'Charizard'), card('sv1', '10', 'Pikachu'),
  ] },
  old_en: { v: 1, set: setRow('old_en', 'old', 'Old Set', 'OLD', 'Base', null), fields: FIELDS, cards: [card('old', '1', 'Mew')] },
}

export const FIXTURE_PRICES = {
  hash: 'P1',
  updatedAt: '2026-10-21',
  fields: ['price_market', 'price_low'],
  rows: [['pbl-117_en', 4.5, 3.2], ['pbl-9_en', 1, 0.5]],
}

/** Fills a store the way a finished F13a sync would. */
export async function seedStore(indexedDB, { lang = 'en', sets = FIXTURE_SETS, prices = FIXTURE_PRICES } = {}) {
  const store = createCardDbStore(indexedDB)
  for (const [id, payload] of Object.entries(sets)) await store.putSet(lang, id, { hash: `h-${id}`, bytes: 10, payload })
  await store.putPrices(lang, prices)
  await store.setMeta(lang, { hash: 'L1', pricesHash: prices.hash, pricesUpdatedAt: prices.updatedAt, sets: Object.keys(sets).length, cards: 0, syncedAt: 1 })
  return store
}

// The Japanese side of a two-language database (F18). pbl_ja shares its catalogue id (pbl) with pbl_en
// and its series with it, jpo_ja exists in Japanese only, and fbk_ja has no native cards: the server
// fills it with the English cards under Japanese ids, marked with the language they come from.
const JA_FIELDS = [...FIELDS, 'data_source_lang', 'image_source_lang']
const jaCard = (tcg, number, name, source = null) => [
  `${tcg}-${number}_ja`, `${tcg}-${number}`, name, tcg, number, 'Common', 'Pokémon', '70', ['Lightning'], [877], `/api/images/card/${tcg}-${number}_ja/small`, 'ja', source, source,
]

export const FIXTURE_SETS_JA = {
  pbl_ja: { v: 1, set: setRow('pbl_ja', 'pbl', 'ペリロウスブルーム', 'PBL', 'Scarlet & Violet', '2026-08-01', 'ja'), fields: JA_FIELDS, cards: [
    jaCard('pbl', '117', 'モルペコ'), jaCard('pbl', '118', 'モルペコ'), jaCard('pbl', '9', 'ピカチュウ'),
  ] },
  jpo_ja: { v: 1, set: setRow('jpo_ja', 'jpo', 'ジャパンオンリー', 'JPO', 'Scarlet & Violet', '2026-09-01', 'ja'), fields: JA_FIELDS, cards: [
    jaCard('jpo', '1', 'ミュウ'),
  ] },
  fbk_ja: { v: 1, set: setRow('fbk_ja', 'fbk', 'フォールバック', 'FBK', 'Scarlet & Violet', '2026-10-01', 'ja'), fields: JA_FIELDS, cards: [
    jaCard('fbk', '1', 'Fallback Mon', 'en'), jaCard('fbk', '2', 'Fallback Two', 'en'),
  ] },
}

export const FIXTURE_PRICES_JA = {
  hash: 'P1J',
  updatedAt: '2026-10-21',
  fields: ['price_market', 'price_low'],
  rows: [['pbl-117_ja', 9, 8]],
}

/** English and Japanese in one store, the way a device that downloaded both has it. */
export async function seedBilingualStore(indexedDB) {
  const store = await seedStore(indexedDB)
  await seedStore(indexedDB, { lang: 'ja', sets: FIXTURE_SETS_JA, prices: FIXTURE_PRICES_JA })
  return store
}
