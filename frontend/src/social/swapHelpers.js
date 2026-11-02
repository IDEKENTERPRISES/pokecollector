// Pure helpers for the swap-offer screens (docs/SOCIAL_DESIGN.md §5), kept apart so they are unit tested.

export const OPEN_STATES = ['proposed', 'countered']
export const ENDED_STATES = ['declined', 'cancelled', 'expired']

/** Server timestamps are naive UTC ("2026-10-30T12:00:00"); read them as UTC. */
export function parseServerTime(value) {
  if (!value) return null
  const text = String(value)
  const time = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`).getTime()
  return Number.isFinite(time) ? time : null
}

export function minutesAgo(value, now = Date.now()) {
  const time = parseServerTime(value)
  return time == null ? null : Math.max(0, Math.floor((now - time) / 60000))
}

/** Row age: "2 h", "40 min", "2 d" (12 or more days: the date). */
export function shortAgeLabel(value, now = Date.now()) {
  const minutes = minutesAgo(value, now)
  if (minutes == null) return ''
  if (minutes < 1) return '<1 min'
  if (minutes < 60) return `${minutes} min`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h`
  return `${Math.floor(minutes / 1440)} d`
}

/** Days left, rounded up and never below 0. null without a date. */
export function daysLeft(expiresAt, now = Date.now()) {
  const time = parseServerTime(expiresAt)
  if (time == null) return null
  return Math.max(0, Math.ceil((time - now) / 86400000))
}

/** "30 Oct", from a server timestamp, in the viewer's time zone. */
export function dayMonth(value, locale) {
  const time = parseServerTime(value)
  if (time == null) return ''
  return new Date(time).toLocaleDateString(locale || 'en-GB', { day: 'numeric', month: 'short' })
}

export function clockTime(value, locale) {
  const time = parseServerTime(value)
  if (time == null) return ''
  return new Date(time).toLocaleTimeString(locale || 'en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function isSameDay(value, now = Date.now()) {
  const time = parseServerTime(value)
  if (time == null) return false
  return new Date(time).toDateString() === new Date(now).toDateString()
}

export const isOpen = offer => OPEN_STATES.includes(offer?.state)

/**
 * Status tone and wording key (docs/SOCIAL_DESIGN.md §5.1). `key` is a `swaps.status.*` string and
 * `partner` fills {name}. The tone is 'yellow' | 'gray' | 'green' | 'red'.
 */
export function swapStatus(offer) {
  const partner = offer?.partner?.username ?? ''
  const base = { partner }
  if (!offer) return { tone: 'gray', key: 'swaps.status.waiting', ...base }
  if ((offer.unavailable?.length ?? 0) > 0 && offer.state === 'accepted') {
    return { tone: 'red', key: 'swaps.status.blocked', ...base }
  }
  if (isOpen(offer)) {
    if (offer.your_turn) {
      return offer.revision > 1
        ? { tone: 'yellow', key: 'swaps.status.yourTurnCountered', ...base }
        : { tone: 'yellow', key: 'swaps.status.yourTurn', ...base }
    }
    return { tone: 'gray', key: 'swaps.status.waiting', ...base }
  }
  if (offer.state === 'accepted') {
    if (offer.you_confirmed && !offer.partner_confirmed) return { tone: 'gray', key: 'swaps.status.waitingSwapped', ...base }
    return { tone: 'green', key: 'swaps.status.accepted', ...base }
  }
  if (offer.state === 'completed') return { tone: 'green', key: 'swaps.status.swapped', ...base }
  return { tone: 'gray', key: `swaps.status.${offer.state}`, ...base }
}

/**
 * The Offers segment's sections from GET /api/swaps: your turn, accepted, waiting for others,
 * finished (docs/SOCIAL_DESIGN.md §5.3). Each is newest change first, as the server sent it.
 */
export function groupOffers(data) {
  const active = [...(data?.incoming ?? []), ...(data?.outgoing ?? [])]
    .sort((a, b) => (parseServerTime(b.updated_at) ?? 0) - (parseServerTime(a.updated_at) ?? 0) || b.id - a.id)
  return {
    yourTurn: active.filter(offer => isOpen(offer) && offer.your_turn),
    accepted: active.filter(offer => offer.state === 'accepted'),
    waiting: active.filter(offer => isOpen(offer) && !offer.your_turn),
    finished: data?.history ?? [],
  }
}

export const joinNames = names => {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The cards on one side of an offer: gives = what the viewer gives. */
export function sideItems(offer, gives) {
  return (offer?.items ?? []).filter(item => Boolean(item.gives) === gives)
}

/** Names for a row ("Charizard ex for your Greninja ex"): no amounts. `t` reads the swaps.* strings. */
export function offerSummary(offer, t) {
  const get = joinNames(sideItems(offer, false).map(item => item.card_name))
  const give = joinNames(sideItems(offer, true).map(item => item.card_name))
  const cash = Number(offer?.cash?.amount) > 0 ? ` ${t('swaps.plusCash')}` : ''
  if (get && give) return `${t('swaps.summaryBoth').replace('{get}', get).replace('{give}', give)}${cash}`
  if (get) return `${get}${cash}`
  return `${t('swaps.summaryGiveOnly').replace('{give}', give)}${cash}`
}

/** Whether the viewer pays the cash, receives it, or there is none. */
export function cashDirection(offer, viewerId) {
  const amount = Number(offer?.cash?.amount) || 0
  if (amount <= 0) return null
  return offer.cash.payer_user_id === viewerId ? 'pay' : 'receive'
}

export function itemKey(item) {
  return item.collection_item_id ?? item.id
}

/** Item ids that were added by the last counter (for the "Added" capsules). */
export function addedKeys(offer) {
  if (!offer || offer.revision <= 1) return new Set()
  return new Set((offer.changes ?? []).filter(change => change.change === 'added').map(change => change.collection_item_id))
}

/**
 * The balance the fair-trade meter draws (docs/SOCIAL_DESIGN.md §5.6): same thresholds as before.
 * gain >= +15 %, fair >= -5 %, close >= -15 %, else lose. `position` (0-1) places the marker
 * across +-30 %. `scoreGives` is the base for the percentage (defaults to `gives`).
 */
export function tradeVerdict({ gives = 0, gets = 0, missingPrices = 0, scoreGives } = {}) {
  const delta = Math.round((gets - gives) * 100) / 100
  const base = scoreGives ?? gives
  const deltaPct = base > 0 ? (delta / base) * 100 : (delta > 0 ? 100 : (delta < 0 ? -100 : 0))
  const position = (Math.max(-30, Math.min(30, deltaPct)) + 30) / 60
  if (missingPrices > 0) return { key: 'missing', delta, deltaPct, position: null }
  if (!(gives > 0 || gets > 0)) return { key: 'empty', delta, deltaPct, position: null }
  let key = 'lose'
  if (deltaPct >= 15) key = 'gain'
  else if (deltaPct >= -5) key = 'fair'
  else if (deltaPct >= -15) key = 'close'
  return { key, delta, deltaPct, position }
}

export const VERDICT_COLOURS = {
  gain: '#0A84FF',
  fair: '#30D158',
  close: '#FFD60A',
  lose: '#FF453A',
  missing: '#FFD60A',
  empty: '#8E8E93',
}

/** What the composer sends: { collection_item_id, quantity } entries from the picked map. */
export function pickedToBody(picked) {
  return Object.entries(picked)
    .filter(([, entry]) => entry.quantity > 0)
    .map(([id, entry]) => ({ collection_item_id: Number(id), quantity: entry.quantity }))
}

/** Count how many copies of each item are on the table, from an offer's items. */
export function offerToPicked(offer, items = offer?.items ?? []) {
  const picked = {}
  items.forEach(item => {
    if (item.collection_item_id != null) picked[item.collection_item_id] = { quantity: item.quantity, gives: Boolean(item.gives), item }
  })
  return picked
}
