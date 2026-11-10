import { buildCardFacets, matchesCardFilters } from '../utils/cardFilters'

// The swap picker lists every card a trainer owns; these helpers narrow that list the way the Collection page
// does (the shared card filters), plus the quick choices: their/your wishlist and Spares.

/** How the shared card filters read a swap candidate (GET /api/swaps/candidates). */
export function candidateFilterParts(item) {
  return {
    card: {
      rarity: item.rarity,
      types: item.types,
      supertype: item.supertype,
      subtypes: item.subtypes,
      trainer_type: item.trainer_type,
      energy_type: item.energy_type,
      stage: item.stage,
    },
    condition: item.condition,
    variant: item.variant,
    printingDetails: item.printing_details,
    setKey: item.set_key ?? item.set_id,
    setName: item.set_name,
    standardLegal: item.standard_legal,
    lang: item.lang,
    quantity: Number(item.quantity) || 0,
    price: Number(item.value) || 0,
  }
}

/** The default quick choice: the wishlist when it applies, otherwise everything. */
export function defaultQuickChoice({ counts, wishlistVisible }) {
  return counts?.wishlist > 0 && wishlistVisible ? 'wishlist' : 'all'
}

/** Pair each candidate with its filter parts once, so typing and filtering do not rebuild them. */
export function prepareCandidates(items) {
  return (items ?? []).map(item => ({ item, parts: candidateFilterParts(item), name: String(item.card_name || '').toLowerCase() }))
}

export function candidateFacets(prepared) {
  return buildCardFacets(prepared, entry => entry.parts)
}

/**
 * quick: 'wishlist' | 'spares' | 'all'. Spares: copies the trainer has more than one of that no binder or deck
 * holds (the backend's `spare` count). `term` is the search text, `filters` the shared card filters.
 */
export function filterCandidates(prepared, { quick = 'all', term = '', filters }) {
  const text = String(term || '').trim().toLowerCase()
  return prepared.filter(({ item, parts, name }) => {
    if (quick === 'wishlist' && !item.on_wishlist) return false
    if (quick === 'spares' && !(Number(item.spare) > 0)) return false
    if (text && !name.includes(text)) return false
    return matchesCardFilters(parts, filters)
  }).map(entry => entry.item)
}
