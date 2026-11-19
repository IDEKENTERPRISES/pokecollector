import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import FamilyPicker from './FamilyPicker'
import { familyGoalParams, filterFamilies, foldText } from './goals'

vi.mock('../components/ios/SearchField', () => ({
  default: ({ placeholder }) => createElement('input', { placeholder }),
}))

const member = (dex_id, name, name_de) => ({ dex_id, name, name_de })
const FAMILIES = [
  { id: 'charmander', name: 'Charmander family', popular: true, members: [member(4, 'Charmander', 'Glumanda'), member(5, 'Charmeleon', 'Glutexo'), member(6, 'Charizard', 'Glurak')] },
  { id: 'flabebe', name: 'Flabébé family', members: [member(669, 'Flabébé', 'Flabébé'), member(670, 'Floette', 'Floette')] },
  { id: 'tauros', name: 'Tauros', members: [member(128, 'Tauros', 'Tauros')] },
  { id: 'caterpie', name: 'Caterpie family', members: [member(10, 'Caterpie', 'Raupy')] },
]
const t = key => key

describe('family search', () => {
  it('folds accents and case', () => {
    expect(foldText('Flabébé')).toBe('flabebe')
    expect(foldText('Fußball')).toBe('fussball')
  })

  it('finds a family by any member, in English or German', () => {
    expect(filterFamilies(FAMILIES, 'chariz').items.map(i => i.family.id)).toEqual(['charmander'])
    expect(filterFamilies(FAMILIES, 'chariz').items[0].matched).toEqual([6])
    expect(filterFamilies(FAMILIES, 'glurak').items.map(i => i.family.id)).toEqual(['charmander'])
    expect(filterFamilies(FAMILIES, 'FLABEBE').items.map(i => i.family.id)).toEqual(['flabebe'])
  })

  it('ranks prefix matches first and shows popular families first without a query', () => {
    expect(filterFamilies(FAMILIES, 'ra').items.map(i => i.family.id)).toEqual(['caterpie', 'charmander'])
    expect(filterFamilies(FAMILIES, '').items[0].family.id).toBe('charmander')
  })

  it('caps the list and reports the total', () => {
    const result = filterFamilies(FAMILIES, '', 2)
    expect(result.items).toHaveLength(2)
    expect(result.total).toBe(4)
  })
})

describe('FamilyPicker', () => {
  const html = renderToStaticMarkup(createElement(FamilyPicker, { families: FAMILIES, onPick: () => {}, t }))

  it('shows the search box and the popular family first, with its members', () => {
    expect(html).toContain('goals.searchPokemon')
    expect(html.indexOf('pick-family-charmander')).toBeGreaterThan(-1)
    expect(html.indexOf('pick-family-charmander')).toBeLessThan(html.indexOf('pick-family-flabebe'))
    expect(html).toContain('Charmander, Charmeleon, Charizard')
  })

  it('has nothing to pick for an unknown name (empty state)', () => {
    expect(filterFamilies(FAMILIES, 'zzzz')).toEqual({ items: [], total: 0 })
  })

  it('turns a picked family into goal params, keeping the old ids', () => {
    expect(familyGoalParams(FAMILIES[0], 'each')).toEqual({ family: 'charmander' })
    expect(familyGoalParams(FAMILIES[0], 'every')).toEqual({ family: 'charmander', every: true })
  })
})
