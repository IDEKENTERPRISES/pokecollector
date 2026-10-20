import { getAvailableVariants, getCardOwnedVariants } from './cardVariants'

// Set detail helpers (design doc §5.4): the Master set stat card and the "Split variants" tiles.
// Both only use data the checklist endpoint already returns.

/**
 * Master set progress: printings owned out of printings available (`variants_*` and price evidence),
 * and the value of the owned printings. `priceOf(card)` gives a card's price; each owned printing is
 * counted at that price times the quantity owned.
 */
export function masterSetStats(cards = [], priceOf = () => 0) {
  let owned = 0
  let total = 0
  let value = 0
  for (const card of cards) {
    const available = getAvailableVariants(card)
    // A card without any advertised printing still counts as one (Normal) printing
    const printings = available.length ? available : ['Normal']
    total += printings.length
    for (const entry of getCardOwnedVariants(card)) {
      if (!printings.includes(entry.variant)) continue
      owned += 1
      value += (Number(priceOf(card)) || 0) * entry.quantity
    }
  }
  return { owned, total, value }
}

/**
 * One tile per available printing of a card, owned or not. Each entry is { key, card, source }:
 * `card` is the card as the tile shows it (owned only in that printing), `source` the original card
 * for the card sheet and the image.
 */
export function splitVariantCards(card) {
  const available = getAvailableVariants(card)
  const printings = available.length ? available : ['Normal']
  const ownedByVariant = new Map(getCardOwnedVariants(card).map(entry => [entry.variant, entry.quantity]))
  return printings.map(variant => {
    const quantity = ownedByVariant.get(variant) ?? 0
    return {
      key: `${card.id}:${variant}`,
      source: card,
      card: {
        ...card,
        owned: quantity > 0,
        owned_quantity: quantity,
        quantity,
        owned_variants: quantity > 0 ? [{ variant, quantity }] : [],
        owned_items: (card.owned_items || []).filter(item => (item.variant || 'Normal') === variant),
      },
    }
  })
}
