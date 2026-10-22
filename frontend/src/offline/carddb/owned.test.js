import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { ownedFromQueryClient } from './owned.js'

const item = (id, cardId, setId, extra = {}) => ({ id, card_id: cardId, quantity: 1, lang: 'en', card: { id: cardId, set_id: setId }, ...extra })

describe('ownedFromQueryClient', () => {
  it('is unknown when the collection and wishlist were never loaded', () => {
    expect(ownedFromQueryClient(new QueryClient())).toEqual({ ownedByCard: null, ownedCounts: null, wishlistedIds: null })
  })

  it('counts distinct owned cards per set and language from the saved collection', () => {
    const client = new QueryClient()
    client.setQueryData(['collection', {}], [item(1, 'pbl-117_en', 'pbl'), item(2, 'pbl-117_en', 'pbl', { variant: 'holo' }), item(3, 'pbl-9_en', 'pbl'), item(4, 'sv1-2_de', 'sv1', { lang: 'de' })])
    client.setQueryData(['wishlist'], [{ card_id: 'pbl-118_en' }])
    const { ownedByCard, ownedCounts, wishlistedIds } = ownedFromQueryClient(client)
    expect(ownedByCard.get('pbl-117_en')).toHaveLength(2)
    expect(ownedCounts.get('pbl|en')).toBe(2)
    expect(ownedCounts.get('sv1|de')).toBe(1)
    expect(wishlistedIds.has('pbl-118_en')).toBe(true)
  })

  it('ignores a filtered collection query (rule-text search), which is not the full list', () => {
    const client = new QueryClient()
    client.setQueryData(['collection', { rule_text: 'x' }], [item(1, 'a', 'pbl')])
    expect(ownedFromQueryClient(client).ownedByCard).toBeNull()
  })
})
