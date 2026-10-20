import { describe, expect, it } from 'vitest'
import { masterSetStats, splitVariantCards } from './setDetailStats'

const card = (id, extra = {}) => ({ id, variants_normal: true, variants_holo: false, variants_reverse: false, owned_variants: [], ...extra })

describe('masterSetStats', () => {
  it('counts owned printings out of available printings and sums their value', () => {
    const cards = [
      card('a', { variants_reverse: true, owned_variants: [{ variant: 'Normal', quantity: 2 }] }),
      card('b', { variants_normal: false, variants_holo: true, owned_variants: [{ variant: 'Holo', quantity: 1 }] }),
      card('c'),
    ]
    expect(masterSetStats(cards, () => 5)).toEqual({ owned: 2, total: 4, value: 15 })
  })
  it('ignores owned printings the card does not advertise', () => {
    const cards = [card('a', { owned_variants: [{ variant: 'Holo', quantity: 1 }] })]
    expect(masterSetStats(cards, () => 1)).toEqual({ owned: 0, total: 1, value: 0 })
  })
})

describe('splitVariantCards', () => {
  it('gives one tile per available printing, owned only in its own printing', () => {
    const source = card('a', { variants_reverse: true, owned: true, owned_variants: [{ variant: 'Reverse Holo', quantity: 3 }] })
    const tiles = splitVariantCards(source)
    expect(tiles.map(tile => tile.key)).toEqual(['a:Normal', 'a:Reverse Holo'])
    expect(tiles[0].card.owned).toBe(false)
    expect(tiles[1].card).toMatchObject({ owned: true, owned_quantity: 3 })
    expect(tiles[1].source).toBe(source)
  })
})
