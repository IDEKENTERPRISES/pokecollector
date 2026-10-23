// A realistic card database for one language, in the downloaded format (F13a): about 200 sets and
// 30,000 cards with the same fields, long texts and price columns as the server's payloads, so the
// offline pages are tested at the size an iPhone really has. Deterministic (seeded), no network.
//
//   const db = buildLargeCarddb()          // { manifest, sets: { [setId]: payload }, prices, ... }
//   db.landmark                            // { setId, tcgId, name, number } - a card to search for

const CARD_FIELDS = [
  'id', 'tcg_card_id', 'name', 'set_id', 'number', 'rarity', 'types', 'supertype', 'subtypes',
  'hp', 'artist', 'stage', 'evolve_from', 'suffix', 'trainer_type', 'energy_type', 'card_effect',
  'regulation_mark', 'attacks', 'abilities', 'weaknesses', 'resistances', 'dex_ids',
  'pokedex_entry_ids', 'cardmarket_products', 'retreat', 'images_small', 'images_large',
  'image_source_lang', 'data_source_lang', 'is_digital', 'lang',
  'variants_normal', 'variants_reverse', 'variants_holo', 'variants_first_edition',
]
const PRICE_FIELDS = [
  'price_market', 'price_low', 'price_mid', 'price_high', 'price_trend',
  'price_avg1', 'price_avg7', 'price_avg30',
  'price_market_holo', 'price_low_holo', 'price_trend_holo',
  'price_avg1_holo', 'price_avg7_holo', 'price_avg30_holo',
  'price_tcg_normal_low', 'price_tcg_normal_mid', 'price_tcg_normal_high', 'price_tcg_normal_market',
  'price_tcg_reverse_low', 'price_tcg_reverse_mid', 'price_tcg_reverse_market',
  'price_tcg_holo_low', 'price_tcg_holo_mid', 'price_tcg_holo_market',
]
const TYPES = ['Fire', 'Water', 'Grass', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Dragon', 'Colorless']
const RARITIES = ['Common', 'Uncommon', 'Rare', 'Rare Holo', 'Double Rare', 'Illustration Rare', 'Ultra Rare']
const SERIES = ['Base', 'Neo', 'e-Card', 'EX', 'Diamond & Pearl', 'Platinum', 'HeartGold & SoulSilver', 'Black & White', 'XY', 'Sun & Moon', 'Sword & Shield', 'Scarlet & Violet', 'Mega Evolution', 'Promos', 'Trainer Kits']
const SYLLABLES = ['pi', 'ka', 'chu', 'mor', 'pe', 'ko', 'char', 'iz', 'ard', 'bul', 'ba', 'saur', 'squir', 'tle', 'eev', 'ee', 'snor', 'lax', 'gen', 'gar', 'ma', 'chop', 'ral', 'ti', 'kir', 'lia', 'dra', 'go', 'nite', 'lu', 'cario', 'tor', 'vi', 'zard', 'moth', 'ra', 'zor', 'cin', 'der', 'wa']

function seeded(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const capital = text => text.charAt(0).toUpperCase() + text.slice(1)

// `tcgPrefix` names the sets' catalogue ids (fx1, fx2 ...): two languages built with the same prefix
// share tcg_set_id values (fx1_en / fx1_ja) the way the real catalogue does. `namePrefix` makes the
// set and card names recognisably native to the language. The last `emptySets` sets carry no cards
// (a set that exists as metadata before its native card data does).
export function buildLargeCarddb({ lang = 'en', setCount = 200, cardsPerSet = 150, seed = 7, tcgPrefix = 'fx', namePrefix = '', emptySets = 0 } = {}) {
  const random = seeded(seed)
  const pick = list => list[Math.floor(random() * list.length)]
  const makeName = () => capital(Array.from({ length: 2 + Math.floor(random() * 2) }, () => pick(SYLLABLES)).join(''))
  const names = Array.from({ length: 900 }, makeName).map(name => `${namePrefix}${name}`)

  const sets = {}
  const setList = []
  const priceRows = []
  let landmark = null

  for (let s = 0; s < setCount; s += 1) {
    const tcgId = `${tcgPrefix}${s + 1}`
    const id = `${tcgId}_${lang}`
    const series = SERIES[s % SERIES.length]
    const month = String((s % 12) + 1).padStart(2, '0')
    const set = {
      id,
      tcg_set_id: tcgId,
      name: `${namePrefix}Fixture ${capital(pick(SYLLABLES))}${pick(SYLLABLES)} ${s + 1}`,
      series,
      series_id: series.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      abbreviation: `F${String(s + 1).padStart(2, '0')}`,
      release_date: `${2000 + Math.floor(s / 10)}-${month}-15`,
      total: cardsPerSet,
      images_symbol: null,
      images_logo: null,
      is_digital: false,
      lang,
    }
    const count = s >= setCount - emptySets ? 0 : Math.max(10, cardsPerSet + Math.floor(random() * 21) - 10)
    const cards = []
    for (let n = 1; n <= count; n += 1) {
      const number = String(n)
      const cardId = `${tcgId}-${number}_${lang}`
      const trainer = random() < 0.15
      const name = trainer ? `${namePrefix}${pick(['Great', 'Ultra', 'Quick', 'Nest'])} ${pick(['Ball', 'Potion', 'Switch', 'Research'])}` : pick(names)
      const type = pick(TYPES)
      const attack = {
        name: capital(pick(SYLLABLES) + pick(SYLLABLES)),
        cost: [type, 'Colorless'],
        damage: String(10 * (1 + Math.floor(random() * 15))),
        effect: 'Flip a coin. If heads, this attack does 30 more damage and your opponent’s Active Pokémon is now Paralyzed.',
      }
      const ability = random() < 0.2 ? { name: capital(pick(SYLLABLES)), type: 'Ability', effect: 'Once during your turn, you may draw a card.' } : null
      cards.push([
        cardId, `${tcgId}-${number}`, name, tcgId, number, pick(RARITIES),
        trainer ? [] : [type], trainer ? 'Trainer' : 'Pokémon', trainer ? ['Item'] : ['Basic'],
        trainer ? null : String(30 + 10 * Math.floor(random() * 25)), `Artist ${Math.floor(random() * 80)}`,
        trainer ? null : 'Basic', null, null, trainer ? 'Item' : null, null,
        trainer ? 'Search your deck for a Pokémon, reveal it, and put it into your hand. Then, shuffle your deck.' : null,
        'G',
        trainer ? [] : [attack], ability ? [ability] : [],
        trainer ? [] : [{ type: pick(TYPES), value: '×2' }], [],
        [Math.floor(random() * 1000)], [], [{ id: 100000 + s * 1000 + n, name }], trainer ? null : 1,
        `/api/images/card/${cardId}/small`, `/api/images/card/${cardId}/large`,
        lang, lang, false, lang, true, random() < 0.7, random() < 0.5, false,
      ])
      priceRows.push([cardId, ...PRICE_FIELDS.map(() => Math.round(random() * 5000) / 100)])
      if (!landmark && s === Math.floor((setCount - emptySets) / 2) && n === 7) {
        // Rename one card to something unique so a test can search for it by name, number and set code.
        cards[cards.length - 1][2] = `${namePrefix}Zorblax`
        landmark = { setId: id, tcgId, name: `${namePrefix}Zorblax`, number, abbreviation: set.abbreviation, setName: set.name, series }
      }
    }
    sets[id] = { v: 1, set, fields: CARD_FIELDS, cards }
    setList.push(set)
  }

  const prices = { v: 1, fields: PRICE_FIELDS, rows: priceRows }
  const cardCount = Object.values(sets).reduce((sum, payload) => sum + payload.cards.length, 0)
  const manifest = {
    enabled: true,
    format: 1,
    languages: {
      [lang]: {
        hash: 'large-hash-1',
        prices_hash: 'large-prices-1',
        prices_updated_at: '2026-10-20T10:00:00',
        prices_bytes: JSON.stringify(prices).length,
        set_count: setCount,
        card_count: cardCount,
        bytes: 0,
        sets: Object.entries(sets).map(([setId, payload]) => ({
          id: setId, hash: `h-${setId}`, cards: payload.cards.length, bytes: JSON.stringify(payload).length,
        })),
      },
    },
  }
  return { lang, manifest, sets, prices, setList, cardCount, landmark }
}
