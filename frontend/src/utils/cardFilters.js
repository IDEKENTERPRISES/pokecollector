import { normalizePrintingDetailName, printingDetailNames } from './printingDetails'

// The card filters shared by the Collection page and the swap picker, so both narrow a list the same way.
// A "row" is whatever the caller lists (a collection item, a swap candidate); `cardFilterParts` below
// describes how each is read.

export const CONDITIONS = ['Mint', 'NM', 'LP', 'MP', 'HP']
export const CARD_CATEGORY_OPTIONS = ['Pokémon', 'Trainer', 'Energy']
export const CARD_SUBTYPE_OPTIONS = ['Item', 'Supporter', 'Stadium', 'Pokémon Tool', 'EX', 'ex', 'GX', 'Stage 1', 'Stage 2', 'Basic']

/** The filter keys and their empty values. Collection keeps these in its URL; the picker keeps them in state. */
export const CARD_FILTER_DEFAULTS = {
  filterRarity: '',
  filterCondition: '',
  filterVariant: '',
  filterPrintingDetail: '',
  filterSet: '',
  filterType: '',
  filterCategories: [],
  filterSubtypes: [],
  filterLegality: '',
  filterLang: '',
  filterMinPrice: '',
  filterMaxPrice: '',
  filterDuplicates: false,
}

export const normalizeCardFilterValue = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .trim()
  .toLowerCase()

export const normalizeCardFilterLabelKey = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .trim()

const CARD_FILTER_DISPLAY_LABELS = new Map(
  [...CARD_CATEGORY_OPTIONS, ...CARD_SUBTYPE_OPTIONS].map(label => [normalizeCardFilterLabelKey(label), label])
)

const getPreferredCardFilterLabel = (value) => (
  CARD_FILTER_DISPLAY_LABELS.get(normalizeCardFilterLabelKey(value)) || String(value || '').trim()
)

export const getCardCategoryLabel = (card) => {
  const supertype = String(card?.supertype || '').trim()
  if (normalizeCardFilterValue(supertype) === 'pokemon') return 'Pokémon'
  if (supertype) return getPreferredCardFilterLabel(supertype)
  return ''
}

export const getCardSubtypeLabels = (card) => {
  const labels = new Set()
  ;(card?.subtypes || []).forEach(subtype => {
    if (subtype) labels.add(getPreferredCardFilterLabel(subtype))
  })
  ;[card?.trainer_type, card?.energy_type, card?.stage].forEach(subtype => {
    if (subtype) labels.add(getPreferredCardFilterLabel(subtype))
  })
  return [...labels].filter(Boolean)
}

export const sortCardFilterLabels = (preferredOrder, labels) => {
  const preferredIndex = new Map(preferredOrder.map((label, index) => [normalizeCardFilterLabelKey(label), index]))
  return [...labels].sort((a, b) => {
    const indexA = preferredIndex.get(normalizeCardFilterLabelKey(a))
    const indexB = preferredIndex.get(normalizeCardFilterLabelKey(b))
    if (indexA !== undefined || indexB !== undefined) {
      return (indexA ?? Number.MAX_SAFE_INTEGER) - (indexB ?? Number.MAX_SAFE_INTEGER)
    }
    return a.localeCompare(b)
  })
}

export const toggleFilterValue = (values, value) => (
  values.includes(value) ? values.filter(item => item !== value) : [...values, value]
)

/**
 * Does one row pass the filters? `parts`: { card, condition, variant, printingDetails, setKey, standardLegal, lang,
 * quantity, price }, where `card` carries rarity, types, supertype, subtypes, trainer_type, energy_type and stage.
 */
export function matchesCardFilters(parts, filters) {
  const {
    filterRarity, filterCondition, filterVariant, filterPrintingDetail, filterSet, filterType,
    filterCategories, filterSubtypes, filterLegality, filterLang, filterMinPrice, filterMaxPrice, filterDuplicates,
  } = filters
  const card = parts.card
  if (filterRarity && card?.rarity !== filterRarity) return false
  if (filterCondition && parts.condition !== filterCondition) return false
  if (filterVariant && parts.variant !== filterVariant) return false
  if (
    filterPrintingDetail
    && !printingDetailNames(parts.printingDetails).some(
      name => normalizePrintingDetailName(name) === normalizePrintingDetailName(filterPrintingDetail)
    )
  ) return false
  if (filterSet && parts.setKey !== filterSet) return false
  if (filterType && !(card?.types || []).includes(filterType)) return false
  if (filterCategories.length > 0) {
    const category = normalizeCardFilterValue(getCardCategoryLabel(card))
    if (!filterCategories.some(filter => normalizeCardFilterValue(filter) === category)) return false
  }
  if (filterSubtypes.length > 0) {
    const subtypes = getCardSubtypeLabels(card).map(normalizeCardFilterLabelKey)
    if (!filterSubtypes.some(filter => subtypes.includes(normalizeCardFilterLabelKey(filter)))) return false
  }
  if (filterLegality === 'standard' && !parts.standardLegal) return false
  if (filterLang && parts.lang !== filterLang) return false
  if (filterMinPrice && parts.price < parseFloat(filterMinPrice)) return false
  if (filterMaxPrice && parts.price > parseFloat(filterMaxPrice)) return false
  if (filterDuplicates && parts.quantity < 2) return false
  return true
}

/** How many filters are set (the number on the Filters button). Category and subtype count once each. */
export function countActiveCardFilters(filters, extra = []) {
  const {
    filterRarity, filterCondition, filterVariant, filterPrintingDetail, filterSet, filterType,
    filterCategories, filterSubtypes, filterLegality, filterLang, filterMinPrice, filterMaxPrice, filterDuplicates,
  } = filters
  return [
    filterRarity, filterCondition, filterVariant, filterPrintingDetail, filterSet, filterType,
    filterLegality, filterLang, filterMinPrice, filterMaxPrice, filterDuplicates, ...extra,
  ].filter(Boolean).length + (filterCategories.length > 0 ? 1 : 0) + (filterSubtypes.length > 0 ? 1 : 0)
}

/** Is a filter from the "Advanced filters" fold set? (The panel opens that fold when so.) */
export function hasAdvancedCardFilters(filters, extra = []) {
  const { filterCategories, filterSubtypes, filterLegality, filterLang, filterMinPrice, filterMaxPrice, filterDuplicates } = filters
  return Boolean(
    filterCategories.length > 0 || filterSubtypes.length > 0 || filterLegality || filterLang
    || filterMinPrice || filterMaxPrice || filterDuplicates || extra.some(Boolean)
  )
}

/**
 * The choices each filter offers, read from the rows that exist. `read(row)` gives { card, setKey, setName,
 * printingDetails } like `matchesCardFilters`.
 */
export function buildCardFacets(rows, read) {
  const rarities = new Set()
  const sets = new Map()
  const types = new Set()
  const categories = new Set(CARD_CATEGORY_OPTIONS)
  const subtypes = new Set(CARD_SUBTYPE_OPTIONS)
  const printingDetails = new Set()
  for (const row of rows) {
    const part = read(row)
    const card = part.card
    if (card?.rarity) rarities.add(card.rarity)
    if (part.setKey) sets.set(part.setKey, part.setName)
    ;(card?.types || []).forEach(type => types.add(type))
    const category = getCardCategoryLabel(card)
    if (category) categories.add(category)
    getCardSubtypeLabels(card).forEach(label => subtypes.add(label))
    printingDetailNames(part.printingDetails).forEach(name => printingDetails.add(name))
  }
  return {
    rarities: [...rarities].sort(),
    sets: [...sets.entries()].filter(([, name]) => name != null).sort((a, b) => a[1].localeCompare(b[1])),
    types: [...types].sort(),
    categories: sortCardFilterLabels(CARD_CATEGORY_OPTIONS, categories),
    subtypes: sortCardFilterLabels(CARD_SUBTYPE_OPTIONS, subtypes),
    printingDetails: [...printingDetails].sort((left, right) => left.localeCompare(right)),
  }
}
