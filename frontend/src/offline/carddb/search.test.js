import { describe, expect, it } from 'vitest'
import { FIXTURE_SETS } from './fixture.js'
import {
  buildNameLists, buildSetIndex, compareNumbers, editDistance, maxEdits, normalizeCardNumber,
  parseQuery, searchCardsOffline, suggestNames,
} from './search.js'

const sets = Object.values(FIXTURE_SETS).map(payload => payload.set)
const cards = Object.values(FIXTURE_SETS).flatMap(payload => payload.cards.map(row => {
  const card = {}
  payload.fields.forEach((field, index) => { card[field] = row[index] })
  return card
}))
const index = buildSetIndex(sets)
const lists = buildNameLists(cards)
const search = (q, extra = {}) => searchCardsOffline({ cards, sets, params: { q, ...extra } })
const ids = result => result.data.map(card => card.id)

describe('parseQuery', () => {
  it('reads a name and a number', () => {
    expect(parseQuery('Morpeko 117', index, lists)).toMatchObject({ name: 'Morpeko', number: '117', changed: true })
  })
  it('reads a set code, id or full name in any position', () => {
    for (const text of ['Morpeko PBL', 'PBL Morpeko', 'Morpeko Perilous Bloom', 'perilous bloom Morpeko']) {
      expect(parseQuery(text, index, lists)).toMatchObject({ name: 'Morpeko', setIds: new Set(['pbl']) })
    }
  })
  it('reads name, number and set in every order', () => {
    for (const text of ['Morpeko 117 PBL', '117 PBL Morpeko', 'PBL 117 Morpeko', 'Morpeko PBL 117', '117/185 Morpeko pbl']) {
      expect(parseQuery(text, index, lists)).toMatchObject({ name: 'Morpeko', number: '117', setIds: new Set(['pbl']) })
    }
  })
  it('never reads a set as the whole query, or a Pokémon name as a set', () => {
    expect(parseQuery('PBL', index, lists)).toMatchObject({ name: 'PBL', changed: false })
    const withMew = buildSetIndex([...sets, { id: 'mew_en', tcg_set_id: 'mew', name: '151', abbreviation: 'MEW' }])
    expect(parseQuery('Mew ex', withMew, lists).changed).toBe(false)
  })
})

describe('edit distance and limits', () => {
  it('allows no typo up to 4 letters, 1 for 5-7 and 2 from 8', () => {
    expect([4, 5, 7, 8, 12].map(maxEdits)).toEqual([0, 1, 1, 2, 2])
  })
  it('counts a swap as one edit and stops at the limit', () => {
    expect(editDistance('morpkeo', 'morpeko', 2)).toBe(1)
    expect(editDistance('morbeko', 'morpeko', 2)).toBe(1)
    expect(editDistance('abcdef', 'uvwxyz', 2)).toBe(3)
  })
})

describe('suggestNames', () => {
  it('corrects a typo to the unique closest name', () => {
    expect(suggestNames('Morbeko', lists)).toEqual(['Morpeko'])
  })
  it('never changes a correct name or a very short one', () => {
    expect(suggestNames('Morpeko', lists)).toEqual([])
    expect(suggestNames('Mewx', lists)).toEqual([])
    expect(suggestNames('Mw', lists)).toEqual([])
  })
  it('gives nothing when two names tie', () => {
    const tied = buildNameLists([{ name: 'Pikaxu', supertype: 'Trainer' }, { name: 'Pikayu', supertype: 'Trainer' }])
    expect(suggestNames('Pikazu', tied)).toEqual([])
  })
  it('prefers a species over a card name on a tie', () => {
    const mixed = buildNameLists([{ name: 'Pikaxu', supertype: 'Pokémon' }, { name: 'Pikayu', supertype: 'Trainer' }])
    expect(suggestNames('Pikazu', mixed)).toEqual(['Pikaxu'])
  })
})

describe("searchCardsOffline (the owner's cases)", () => {
  it('"Morpeko 117" finds Morpeko PBL 117 and the same number in other sets', () => {
    expect(ids(search('Morpeko 117')).sort()).toEqual(['pbl-117_en', 'sv1-117_en'])
    expect(ids(search('Morpeko 117 PBL'))).toEqual(['pbl-117_en'])
  })
  it('"Morpeko PBL" is every Morpeko in that set', () => {
    expect(ids(search('Morpeko PBL')).sort()).toEqual(['pbl-117_en', 'pbl-118_en'])
  })
  it('gives the same single card in any word order', () => {
    for (const text of ['Morpeko 117 PBL', '117 PBL Morpeko', 'PBL Morpeko 117', 'pbl 117 morpeko']) {
      expect(ids(search(text))).toEqual(['pbl-117_en'])
    }
  })
  it('"Morbeko" searches Morpeko and says Morbeko was not found', () => {
    const result = search('Morbeko')
    expect(result.corrected).toEqual({ from: 'Morbeko', to: 'Morpeko' })
    expect(result.total_count).toBe(3)
  })
  it('corrects the name inside a set and number search too', () => {
    const result = search('Morbeko 117 PBL')
    expect(ids(result)).toEqual(['pbl-117_en'])
    expect(result.corrected.to).toBe('Morpeko')
  })
  it('does not correct when something was found, or a short name', () => {
    expect(search('Morpeko').corrected).toBeUndefined()
    const none = search('Mewx')
    expect(none.total_count).toBe(0)
    expect(none.corrected).toBeUndefined()
  })
  it('looks up a set code with a number', () => {
    expect(ids(search('PBL 117'))).toEqual(['pbl-117_en'])
    expect(ids(search('sv1 002'))).toEqual(['sv1-2_en'])
  })
  it('ignores accents and case, and sorts and pages', () => {
    expect(ids(search('poke ball'))).toEqual(['pbl-120_en'])
    expect(ids(search('', { set_id: 'pbl_en', sort_by: 'number' }))).toEqual(['pbl-9_en', 'pbl-117_en', 'pbl-118_en', 'pbl-120_en'])
    expect(search('', { page: 2, page_size: 3 }).data).toHaveLength(3)
  })
})

describe('card numbers', () => {
  it('treats 044 and 44 as equal and sorts naturally', () => {
    expect(normalizeCardNumber('044')).toBe('44')
    expect(['10', '2', '1', '74a', '74'].sort(compareNumbers)).toEqual(['1', '2', '10', '74', '74a'])
  })
})
