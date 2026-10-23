// Offline smart card search (F13b): a port of backend/services/card_search_query.py (F6), so a
// phone with no network finds "Morpeko 117", "Morpeko PBL", "117 PBL Morpeko" and "Morbeko" the
// way the server does. Pure functions over plain arrays; the store adapters feed them.
//
// One difference from the server: the server knows every species from its Pokédex catalogue,
// the phone only has card data, so species are the names (and their words) of Pokémon cards.

export const MIN_PREFIX_LENGTH = 4
const NUMBER_RE = /^(?:\d{1,4}|[a-z]{1,4}\d{1,3})(?:\/[a-z0-9]+)?$/i
const CODE_NUMBER_RE = /^([A-Za-z][A-Za-z0-9]*)\s+(\d+)$/

export function stripDiacritics(value) {
  if (value === null || value === undefined) return ''
  return String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

export const normalizeWords = text => stripDiacritics(text).match(/[\p{L}\p{N}]+/gu) ?? []
export const normalizeName = text => normalizeWords(text).join(' ')

const addTo = (map, key, value) => {
  if (!map.has(key)) map.set(key, new Set())
  map.get(key).add(value)
}

/** Visible sets keyed for lookups: abbreviation/tcg id/id -> tcg set ids, and normalised name -> tcg set ids. */
export function buildSetIndex(sets) {
  const codes = new Map()
  const names = new Map()
  for (const item of sets ?? []) {
    const tcgId = item.tcg_set_id || item.id
    if (!tcgId) continue
    for (const code of [item.abbreviation, item.tcg_set_id, item.id]) {
      const key = normalizeWords(code).join('')
      if (key) addTo(codes, key, tcgId)
    }
    const name = normalizeName(item.name)
    if (name) addTo(names, name, tcgId)
  }
  return { codes, names }
}

/** Species names ({ normalised -> as printed }) and their words, from the Pokémon cards. */
export function buildNameLists(cards) {
  const species = new Map()
  const catalogue = new Map()
  for (const card of cards ?? []) {
    const key = normalizeName(card.name)
    if (!key) continue
    if (!catalogue.has(key)) catalogue.set(key, card.name)
    if (stripDiacritics(card.supertype) === 'pokemon' && !species.has(key)) species.set(key, card.name)
  }
  const speciesWords = new Set()
  for (const name of species.keys()) for (const word of name.split(' ')) speciesWords.add(word)
  return { species, catalogue, speciesWords }
}

const emptyLists = { species: new Map(), catalogue: new Map(), speciesWords: new Set() }

/**
 * Splits a free-text query into a name, set ids and a card number. A word that is also a
 * Pokémon name is never read as a set code ("Mew ex" stays a name search although MEW is a
 * set), and a set can never be the whole query.
 */
export function parseQuery(text, index, lists = emptyLists) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean)
  const knownWords = lists.speciesWords ?? new Set()
  const keyed = words.map(word => normalizeWords(word).join(''))
  const used = words.map(() => false)
  let setIds = new Set()

  // 1. Full set names, longest runs first ("Vivid Voltage").
  const tokens = words.map(normalizeName)
  for (let size = Math.min(words.length, 6); size >= 1; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      if (used.slice(start, start + size).some(Boolean) || setIds.size) continue
      if (size === words.length) continue // a set cannot be the whole query
      const run = tokens.slice(start, start + size).filter(Boolean).join(' ')
      const matches = index.names.get(run)
      if (!matches) continue
      if (size === 1 && knownWords.has(run)) continue
      setIds = new Set(matches)
      for (let position = start; position < start + size; position += 1) used[position] = true
    }
  }

  // 2. A set abbreviation or id.
  if (!setIds.size) {
    for (let position = 0; position < keyed.length; position += 1) {
      const key = keyed[position]
      if (used[position] || !key || knownWords.has(key) || words.length === 1) continue
      const matches = index.codes.get(key)
      if (matches) {
        setIds = new Set(matches)
        used[position] = true
        break
      }
    }
  }

  // 3. A unique prefix of a set name (4+ characters) that no Pokémon name starts with.
  if (!setIds.size && words.length > 1) {
    for (let position = 0; position < keyed.length; position += 1) {
      const key = keyed[position]
      if (used[position] || key.length < MIN_PREFIX_LENGTH || knownWords.has(key)) continue
      if ([...lists.species.keys()].some(name => name.startsWith(key))) continue
      const prefixed = [...index.names].filter(([name]) => name.startsWith(key)).map(([, ids]) => ids)
      if (prefixed.length === 1) {
        setIds = new Set(prefixed[0])
        used[position] = true
        break
      }
    }
  }

  // 4. A number.
  let number = ''
  for (let position = 0; position < words.length; position += 1) {
    if (used[position] || !NUMBER_RE.test(words[position])) continue
    number = words[position].split('/')[0]
    used[position] = true
    break
  }

  const name = words.filter((_, position) => !used[position]).join(' ')
  return { name, setIds, number, changed: Boolean(setIds.size || number) }
}

// ── Fuzzy names ──────────────────────────────────────────────────────────────

/** Typos allowed for a name of this length: none up to 4 letters, 1 for 5-7, 2 from 8. */
export function maxEdits(length) {
  if (length <= 4) return 0
  if (length <= 7) return 1
  return 2
}

/** Damerau-Levenshtein (optimal string alignment), or limit+1 when it exceeds the limit. */
export function editDistance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  let previous2 = null
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array(b.length + 1).fill(0)
    current[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
      if (previous2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, previous2[j - 2] + 1)
      }
      current[j] = value
    }
    if (Math.min(...current) > limit) return limit + 1
    previous2 = previous
    previous = current
  }
  return previous[b.length]
}

/**
 * Candidate corrections for a misspelt name, best first, within the strict limits. Nothing when
 * the query is already a known name, or when two different names tie (species win a tie).
 */
export function suggestNames(query, lists) {
  const normalized = normalizeName(query)
  const limit = maxEdits(normalized.length)
  if (!normalized || limit === 0) return []
  const { species, catalogue } = lists
  if (species.has(normalized) || catalogue.has(normalized)) return []

  let best = limit + 1
  const found = new Map()
  const candidates = new Map([...catalogue, ...species])
  for (const candidate of candidates.keys()) {
    const distance = editDistance(normalized, candidate, limit)
    if (distance > limit) continue
    found.set(candidate, distance)
    best = Math.min(best, distance)
  }
  let closest = [...found].filter(([, distance]) => distance === best).map(([name]) => name)
  if (!closest.length) return []
  if (closest.length > 1) {
    const closestSpecies = closest.filter(name => species.has(name))
    if (closestSpecies.length !== 1) return []
    closest = closestSpecies
  }
  return closest.map(name => species.get(name) ?? catalogue.get(name))
}

// ── Card numbers ─────────────────────────────────────────────────────────────

export function normalizeCardNumber(value) {
  const text = value === null || value === undefined ? '' : String(value).trim()
  if (!text) return ''
  if (/^\d+$/.test(text)) return text.replace(/^0+/, '') || '0'
  return text.toLowerCase()
}

export function naturalNumberKey(number) {
  if (number === null || number === undefined) return [[2, '']]
  const parts = String(number).trim().match(/\d+|\D+/g) ?? []
  return parts.length ? parts.map(part => (/^\d+$/.test(part) ? [0, Number(part)] : [1, part.toLowerCase()])) : [[2, '']]
}

export function compareNumbers(a, b) {
  const left = naturalNumberKey(a)
  const right = naturalNumberKey(b)
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index][0] !== right[index][0]) return left[index][0] - right[index][0]
    if (left[index][1] !== right[index][1]) return left[index][1] < right[index][1] ? -1 : 1
  }
  return left.length - right.length
}

const hasText = (value, term) => stripDiacritics(typeof value === 'string' ? value : JSON.stringify(value ?? '')).includes(stripDiacritics(term))
const collator = new Intl.Collator()

/** The "rule text" filter: card effect, attacks or abilities contain the term. */
export const matchesRuleText = (card, term) => (
  hasText(card.card_effect, term) || hasText(card.attacks, term) || hasText(card.abilities, term)
)

/**
 * The whole offline search, mirroring GET /cards/search. `cards` are decoded card objects (with
 * `set_id` = tcg set id and `lang`), `sets` the matching set rows. Returns the same envelope:
 * `{ data, total_count, page, page_size, corrected? }`.
 *
 * Cards may carry `nameKey` (their name already normalised) and the caller may pass `prepared`
 * ({ index, lists, setByKey }, built once) so a search over tens of thousands of cards does not
 * redo that work each time.
 */
export function searchCardsOffline({ cards, sets, params = {}, prepared = null }) {
  const {
    q, name, number, set_id: setFilter, type, category, subtype, rarity, artist, rule_text: ruleText,
    hp_min: hpMin, hp_max: hpMax, dex_id: dexId, sort_by: sortBy, sort_order: sortOrder = 'asc',
    page = 1, page_size: pageSize = 20,
  } = params
  const term = String(q ?? '').trim() || String(name ?? '').trim()
  const index = prepared?.index ?? buildSetIndex(sets)
  const lists = prepared?.lists ?? buildNameLists(cards)
  // Keyed by the composite set id only: the same tcg_set_id exists once per language, so a bare one
  // would resolve to whichever language came last.
  const setByKey = prepared?.setByKey ?? new Map()
  if (!prepared?.setByKey) {
    for (const item of sets ?? []) setByKey.set(item.id, item)
  }
  const nameWanted = nameText => stripDiacritics(nameText)

  const runSearch = (nameText, smartSetIds, smartNumber) => {
    let result = cards
    if (nameText) {
      const wanted = nameWanted(nameText)
      result = result.filter(card => (card.nameKey ?? stripDiacritics(card.name)).includes(wanted))
    }
    if (smartSetIds?.size) result = result.filter(card => smartSetIds.has(card.set_id))
    if (smartNumber) {
      const wanted = normalizeCardNumber(smartNumber)
      result = result.filter(card => normalizeCardNumber(card.number) === wanted)
    }
    if (setFilter) {
      const setObj = setByKey.get(setFilter)
      const target = setObj ? (setObj.tcg_set_id || setObj.id) : setFilter
      // A composite id names one language's set; a bare catalogue id matches the set in every language.
      const targetLang = setObj?.lang ?? null
      result = result.filter(card => card.set_id === target && (!targetLang || card.lang === targetLang))
    }
    const wantedNumber = normalizeCardNumber(String(number ?? '').trim())
    if (wantedNumber) result = result.filter(card => normalizeCardNumber(card.number) === wantedNumber)
    if (type) result = result.filter(card => hasText(card.types, type))
    if (category) result = result.filter(card => hasText(card.supertype, category))
    if (subtype) {
      result = result.filter(card => [card.trainer_type, card.energy_type, card.stage, card.suffix, card.subtypes].some(value => hasText(value, subtype)))
    }
    if (rarity) result = result.filter(card => hasText(card.rarity, rarity))
    if (artist) result = result.filter(card => hasText(card.artist, artist))
    if (ruleText) {
      result = result.filter(card => matchesRuleText(card, ruleText))
    }
    const hpOf = card => Number.parseInt(card.hp, 10)
    if (hpMin !== undefined && hpMin !== null && hpMin !== '') result = result.filter(card => hpOf(card) >= Number(hpMin))
    if (hpMax !== undefined && hpMax !== null && hpMax !== '') result = result.filter(card => hpOf(card) <= Number(hpMax))
    if (dexId) result = result.filter(card => Array.isArray(card.dex_ids) && card.dex_ids.includes(Number(dexId)))

    const column = { number: 'number', rarity: 'rarity', price_low: 'price_low', price_market: 'price_market' }[sortBy] ?? 'name'
    const direction = sortOrder === 'desc' ? -1 : 1
    const sorted = [...result].sort((a, b) => {
      const left = a[column]
      const right = b[column]
      if (left === right) return 0
      if (left === null || left === undefined) return 1
      if (right === null || right === undefined) return -1
      if (column === 'number') return compareNumbers(left, right) * direction
      if (typeof left === 'number' && typeof right === 'number') return (left - right) * direction
      return collator.compare(String(left), String(right)) * direction
    })
    const start = (Number(page) - 1) * Number(pageSize)
    return { total: sorted.length, cards: sorted.slice(start, start + Number(pageSize)) }
  }

  let smart = null
  if (term) {
    const match = CODE_NUMBER_RE.exec(term)
    if (match && index.codes.has(normalizeWords(match[1]).join('')) && !lists.speciesWords.has(normalizeWords(match[1]).join(''))) {
      const found = runSearch('', index.codes.get(normalizeWords(match[1]).join('')), match[2])
      return { data: found.cards, total_count: found.total, page: Number(page), page_size: Number(pageSize) }
    }
    const parsed = parseQuery(term, index, lists)
    if (parsed.changed) smart = parsed
  }

  const attempts = []
  if (smart) attempts.push([smart.name, smart.setIds, smart.number])
  attempts.push([term, null, null])
  let outcome = { total: 0, cards: [] }
  for (const [nameText, ids, num] of attempts) {
    outcome = runSearch(nameText, ids, num)
    if (outcome.total) break
  }

  let corrected = null
  if (!outcome.total && term) {
    const typoText = smart ? smart.name : term
    const [suggestion] = suggestNames(typoText, lists)
    if (suggestion) {
      const fuzzy = runSearch(suggestion, smart?.setIds, smart?.number)
      if (fuzzy.total) {
        outcome = fuzzy
        corrected = { from: typoText, to: suggestion }
      }
    }
  }

  const response = { data: outcome.cards, total_count: outcome.total, page: Number(page), page_size: Number(pageSize) }
  if (corrected) response.corrected = corrected
  return response
}
