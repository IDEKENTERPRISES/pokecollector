// The owned state for card-database answers (F13b): read from what the app already holds, the
// collection and wishlist lists the read cache restores. `null` means "unknown" (those lists were
// never loaded), so a page shows no owned figures rather than a wrong zero.

const FULL_COLLECTION_KEY = ['collection', {}]
const FULL_WISHLIST_KEY = ['wishlist']

/** `{ ownedByCard, ownedCounts, wishlistedIds }` from the query client, or nulls when unknown. */
export function ownedFromQueryClient(queryClient) {
  const collection = queryClient.getQueryData(FULL_COLLECTION_KEY)
  const wishlist = queryClient.getQueryData(FULL_WISHLIST_KEY)
  const result = { ownedByCard: null, ownedCounts: null, wishlistedIds: null }
  if (Array.isArray(collection)) {
    const ownedByCard = new Map()
    const perSet = new Map()
    for (const item of collection) {
      const cardId = item.card_id ?? item.card?.id
      if (!cardId) continue
      if (!ownedByCard.has(cardId)) ownedByCard.set(cardId, [])
      ownedByCard.get(cardId).push(item)
      const setId = item.card?.set_id
      if (setId) {
        const key = `${setId}|${item.lang || item.card?.lang || 'en'}`
        if (!perSet.has(key)) perSet.set(key, new Set())
        perSet.get(key).add(cardId)
      }
    }
    result.ownedByCard = ownedByCard
    result.ownedCounts = new Map([...perSet].map(([key, cards]) => [key, cards.size]))
  }
  if (Array.isArray(wishlist)) {
    result.wishlistedIds = new Set(wishlist.map(item => item.card_id ?? item.card?.id).filter(Boolean))
  }
  return result
}
