import { describe, expect, it } from 'vitest'
import { CARD_FILTER_DEFAULTS } from '../utils/cardFilters'
import { candidateFacets, candidateFilterParts, defaultQuickChoice, filterCandidates, prepareCandidates } from './swapPicker'

const card = (id, extra = {}) => ({
  collection_item_id: id,
  card_id: `c${id}_en`,
  card_name: `Card ${id}`,
  set_id: 'sv1',
  set_key: 'sv1_en',
  set_name: 'Scarlet & Violet',
  variant: 'Normal',
  condition: 'NM',
  lang: 'en',
  types: ['Fire'],
  rarity: 'Common',
  supertype: 'Pokemon',
  subtypes: ['Basic'],
  stage: 'Basic',
  standard_legal: true,
  printing_details: [],
  quantity: 1,
  offerable: 1,
  spare: 0,
  on_wishlist: false,
  value: 1,
  ...extra,
})

const ITEMS = [
  card(1),
  card(2, { quantity: 3, offerable: 3, spare: 2, rarity: 'Rare Holo', value: 12, on_wishlist: true }),
  card(3, { quantity: 2, offerable: 2, spare: 0, condition: 'LP', types: ['Water'], set_key: 'sv2_en', set_name: 'Paldea Evolved', standard_legal: false }),
  card(4, { supertype: 'Trainer', subtypes: ['Supporter'], types: [], stage: null, trainer_type: 'Supporter', lang: 'de', printing_details: ['Stamped'], value: 0.5 }),
]
const run = (options) => filterCandidates(prepareCandidates(ITEMS), { filters: CARD_FILTER_DEFAULTS, ...options }).map(item => item.collection_item_id)

describe('swap picker filtering', () => {
  it('lists every card by default, not only spares', () => {
    expect(run({})).toEqual([1, 2, 3, 4])
  })

  it('Spares keeps copies with a spare count (more than one, none held by a binder or deck)', () => {
    expect(run({ quick: 'spares' })).toEqual([2])
  })

  it('the wishlist choice keeps wishlist cards', () => {
    expect(run({ quick: 'wishlist' })).toEqual([2])
  })

  it('searches by name', () => {
    expect(run({ term: ' card 3 ' })).toEqual([3])
  })

  it('applies the Collection filters', () => {
    const only = (filters, extra) => run({ filters: { ...CARD_FILTER_DEFAULTS, ...filters }, ...extra })
    expect(only({ filterRarity: 'Rare Holo' })).toEqual([2])
    expect(only({ filterCondition: 'LP' })).toEqual([3])
    expect(only({ filterSet: 'sv2_en' })).toEqual([3])
    expect(only({ filterType: 'Water' })).toEqual([3])
    expect(only({ filterCategories: ['Trainer'] })).toEqual([4])
    expect(only({ filterSubtypes: ['Supporter'] })).toEqual([4])
    expect(only({ filterLegality: 'standard' })).toEqual([1, 2, 4])
    expect(only({ filterLang: 'de' })).toEqual([4])
    expect(only({ filterPrintingDetail: 'stamped' })).toEqual([4])
    expect(only({ filterMinPrice: '5' })).toEqual([2])
    expect(only({ filterMaxPrice: '0.5' })).toEqual([4])
    expect(only({ filterDuplicates: true })).toEqual([2, 3])
  })

  it('combines Spares with the filters', () => {
    expect(run({ quick: 'spares', filters: { ...CARD_FILTER_DEFAULTS, filterRarity: 'Common' } })).toEqual([])
    expect(run({ quick: 'spares', filters: { ...CARD_FILTER_DEFAULTS, filterMinPrice: '10' } })).toEqual([2])
  })

  it('reads a candidate the way the filters expect', () => {
    expect(candidateFilterParts(ITEMS[1])).toMatchObject({ setKey: 'sv1_en', quantity: 3, price: 12, lang: 'en' })
    expect(candidateFilterParts({ ...ITEMS[0], set_key: undefined })).toMatchObject({ setKey: 'sv1' })
  })

  it('offers the choices that exist', () => {
    const facets = candidateFacets(prepareCandidates(ITEMS))
    expect(facets.rarities).toEqual(['Common', 'Rare Holo'])
    expect(facets.sets).toEqual([['sv2_en', 'Paldea Evolved'], ['sv1_en', 'Scarlet & Violet']])
    expect(facets.types).toEqual(['Fire', 'Water'])
    expect(facets.printingDetails).toEqual(['Stamped'])
  })

  it('opens on the wishlist only when it applies', () => {
    expect(defaultQuickChoice({ counts: { wishlist: 2 }, wishlistVisible: true })).toBe('wishlist')
    expect(defaultQuickChoice({ counts: { wishlist: 2 }, wishlistVisible: false })).toBe('all')
    expect(defaultQuickChoice({ counts: { wishlist: 0 }, wishlistVisible: true })).toBe('all')
  })
})
