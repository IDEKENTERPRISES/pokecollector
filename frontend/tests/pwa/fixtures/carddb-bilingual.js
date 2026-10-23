// An English and a Japanese card database at the size an iPhone really has (F18): 300 sets and about
// 30,000 cards in the downloaded format, built from carddb-large.js so the payloads match the
// server's. It carries the shapes that went wrong:
//   - the same catalogue ids in both languages (fx1_en / fx1_ja) and the same series ids,
//   - Japanese-only sets (jx1_ja ...),
//   - the last Japanese sets without native cards: the server fills them with the English cards
//     under Japanese ids, marked data_source_lang / image_source_lang = 'en'.
// Japanese names start with 'ジ' so a test can tell at a glance whose card it is looking at.

import { buildLargeCarddb } from './carddb-large.js'

export const SET_COUNT = 150
export const FALLBACK_SETS = 3
export const JA_ONLY_SETS = 10
export const JA_PREFIX = 'ジ'

export function buildBilingualCarddb() {
  const en = buildLargeCarddb({ lang: 'en', setCount: SET_COUNT, cardsPerSet: 100, seed: 7 })
  const ja = buildLargeCarddb({ lang: 'ja', setCount: SET_COUNT, cardsPerSet: 100, seed: 11, namePrefix: JA_PREFIX, emptySets: FALLBACK_SETS })
  const jaOnly = buildLargeCarddb({ lang: 'ja', setCount: JA_ONLY_SETS, cardsPerSet: 100, seed: 13, namePrefix: JA_PREFIX, tcgPrefix: 'jx' })
  Object.assign(ja.sets, jaOnly.sets)
  ja.setList.push(...jaOnly.setList)
  ja.prices.rows.push(...jaOnly.prices.rows)

  const fields = ja.sets.fx1_ja.fields
  const at = Object.fromEntries(fields.map((field, index) => [field, index]))
  const fallbackSets = []
  for (let n = SET_COUNT - FALLBACK_SETS + 1; n <= SET_COUNT; n += 1) {
    const payload = ja.sets[`fx${n}_ja`]
    const sibling = en.sets[`fx${n}_en`]
    payload.cards = sibling.cards.map(row => {
      const card = [...row]
      const id = `${card[at.tcg_card_id]}_ja`
      card[at.id] = id
      card[at.images_small] = `/api/images/card/${id}/small`
      card[at.images_large] = `/api/images/card/${id}/large`
      card[at.image_source_lang] = 'en'
      card[at.data_source_lang] = 'en'
      card[at.lang] = 'ja'
      return card
    })
    fallbackSets.push(payload.set)
  }

  const cardCount = lang => Object.values(lang.sets).reduce((sum, payload) => sum + payload.cards.length, 0)
  ja.cardCount = cardCount(ja)
  const entry = ja.manifest.languages.ja
  entry.sets = Object.entries(ja.sets).map(([id, payload]) => ({
    id, hash: `h-${id}`, cards: payload.cards.length, bytes: JSON.stringify(payload).length,
  }))
  entry.set_count = entry.sets.length
  entry.card_count = ja.cardCount
  entry.prices_bytes = JSON.stringify(ja.prices).length

  const manifest = { enabled: true, format: 1, languages: { en: en.manifest.languages.en, ja: entry } }
  const dbs = { en, ja }
  const bodies = {
    manifest: JSON.stringify(manifest),
    prices: { en: JSON.stringify(en.prices), ja: JSON.stringify(ja.prices) },
    sets: Object.fromEntries(['en', 'ja'].map(lang => [lang, Object.fromEntries(
      Object.entries(dbs[lang].sets).map(([id, payload]) => [id, JSON.stringify(payload)]),
    )])),
  }
  return {
    en,
    ja,
    dbs,
    bodies,
    manifest,
    fields,
    setTotal: en.setList.length + ja.setList.length,
    cardTotal: en.cardCount + ja.cardCount,
    twin: ja.setList.find(set => set.tcg_set_id === 'fx10'),
    fallback: fallbackSets[0],
    jaOnly: ja.setList.find(set => set.tcg_set_id === 'jx3'),
  }
}
