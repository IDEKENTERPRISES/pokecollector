import { describe, expect, it } from 'vitest'
import {
  CARD_FILTER_DEFAULTS,
  buildCardFacets,
  countActiveCardFilters,
  getCardCategoryLabel,
  getCardSubtypeLabels,
  hasAdvancedCardFilters,
  matchesCardFilters,
  toggleFilterValue,
} from './cardFilters'

const parts = (extra = {}) => ({
  card: { rarity: 'Rare', types: ['Fire'], supertype: 'Pokemon', subtypes: ['Stage 1'] },
  condition: 'NM', variant: 'Holo', printingDetails: ['Stamped'], setKey: 'sv1_en', standardLegal: true,
  lang: 'en', quantity: 2, price: 4, ...extra,
})
const passes = (filters, extra) => matchesCardFilters(parts(extra), { ...CARD_FILTER_DEFAULTS, ...filters })

describe('shared card filters', () => {
  it('lets everything through with no filters', () => {
    expect(passes({})).toBe(true)
  })

  it('matches each filter', () => {
    expect(passes({ filterRarity: 'Rare' })).toBe(true)
    expect(passes({ filterRarity: 'Common' })).toBe(false)
    expect(passes({ filterCondition: 'LP' })).toBe(false)
    expect(passes({ filterVariant: 'Holo' })).toBe(true)
    expect(passes({ filterPrintingDetail: ' stamped ' })).toBe(true)
    expect(passes({ filterPrintingDetail: 'Promo' })).toBe(false)
    expect(passes({ filterSet: 'sv2_en' })).toBe(false)
    expect(passes({ filterType: 'Fire' })).toBe(true)
    expect(passes({ filterType: 'Water' })).toBe(false)
    expect(passes({ filterCategories: ['Pokémon'] })).toBe(true)
    expect(passes({ filterCategories: ['Trainer'] })).toBe(false)
    expect(passes({ filterSubtypes: ['Stage 1'] })).toBe(true)
    expect(passes({ filterSubtypes: ['Item'] })).toBe(false)
    expect(passes({ filterLegality: 'standard' }, { standardLegal: false })).toBe(false)
    expect(passes({ filterLang: 'de' })).toBe(false)
  })

  it('bounds the price and keeps duplicates', () => {
    expect(passes({ filterMinPrice: '4' })).toBe(true)
    expect(passes({ filterMinPrice: '4.01' })).toBe(false)
    expect(passes({ filterMaxPrice: '3.99' })).toBe(false)
    expect(passes({ filterDuplicates: true })).toBe(true)
    expect(passes({ filterDuplicates: true }, { quantity: 1 })).toBe(false)
  })

  it('counts a category or subtype choice once and flags the advanced ones', () => {
    expect(countActiveCardFilters(CARD_FILTER_DEFAULTS)).toBe(0)
    expect(countActiveCardFilters({ ...CARD_FILTER_DEFAULTS, filterCategories: ['Trainer', 'Energy'], filterRarity: 'Rare' })).toBe(2)
    expect(countActiveCardFilters(CARD_FILTER_DEFAULTS, ['rule'])).toBe(1)
    expect(hasAdvancedCardFilters({ ...CARD_FILTER_DEFAULTS, filterRarity: 'Rare' })).toBe(false)
    expect(hasAdvancedCardFilters({ ...CARD_FILTER_DEFAULTS, filterMaxPrice: '3' })).toBe(true)
  })

  it('reads category and subtype labels', () => {
    expect(getCardCategoryLabel({ supertype: 'pokemon' })).toBe('Pokémon')
    expect(getCardSubtypeLabels({ subtypes: ['ex'], trainer_type: 'Item', stage: 'Basic' }).sort()).toEqual(['Basic', 'Item', 'ex'])
    expect(toggleFilterValue(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleFilterValue(['a', 'b'], 'a')).toEqual(['b'])
  })

  it('builds facets from the rows', () => {
    const facets = buildCardFacets([1, 2], n => parts(n === 1 ? {} : { setKey: 'a_en', setName: 'A', card: { rarity: 'Common', types: ['Water'], supertype: 'Trainer' } }))
    expect(facets.rarities).toEqual(['Common', 'Rare'])
    expect(facets.types).toEqual(['Fire', 'Water'])
    expect(facets.categories.slice(0, 3)).toEqual(['Pokémon', 'Trainer', 'Energy'])
  })
})
