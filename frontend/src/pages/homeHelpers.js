// Pure helpers for the Home screen (design doc §5.1), kept apart so they can be unit tested.

const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** The string key for a count: `<base>One` for exactly one, `<base>` otherwise. */
export function pluralKey(base, count) {
  return Number(count) === 1 ? `${base}One` : base
}

/** Sets whose every card is owned. */
export function completeSetCount(sets) {
  return (sets ?? []).filter(set => num(set?.total) > 0 && num(set?.owned_count) >= num(set.total)).length
}

/** Started but unfinished sets, closest to complete first (ties: the larger set). */
export function closestToCompleteSets(sets, limit = 8) {
  return (sets ?? [])
    .filter(set => num(set?.total) > 0 && num(set?.owned_count) > 0 && num(set.owned_count) < num(set.total))
    .map(set => ({ set, fraction: num(set.owned_count) / num(set.total) }))
    .sort((a, b) => b.fraction - a.fraction || num(b.set.total) - num(a.set.total))
    .slice(0, limit)
    .map(entry => entry.set)
}

/**
 * The to-do cards to show, in order, each only when its count is non-zero. Scan review wins over
 * "processing" so one scans card is shown at a time.
 */
export function todoCards({
  scanAttention = 0,
  scansActive = false,
  queueEnabled = false,
  outboxCount = 0,
  customMatches = 0,
  productsToReview = 0,
  newSets = 0,
} = {}) {
  const cards = []
  if (num(scanAttention) > 0) cards.push({ key: 'scans-review', count: num(scanAttention) })
  else if (scansActive) cards.push({ key: 'scans-processing', count: 0 })
  if (queueEnabled && num(outboxCount) > 0) cards.push({ key: 'sync', count: num(outboxCount) })
  if (num(customMatches) > 0) cards.push({ key: 'matches', count: num(customMatches) })
  if (num(productsToReview) > 0) cards.push({ key: 'products', count: num(productsToReview) })
  if (num(newSets) > 0) cards.push({ key: 'new-sets', count: num(newSets) })
  return cards
}

/** The series of one field from the investment tracker, finite numbers only. */
export function trackerSeries(tracker, field = 'value') {
  return (tracker ?? []).map(point => Number(point?.[field])).filter(Number.isFinite)
}

/** Last minus first of a series, or null with fewer than two points. */
export function seriesChange(values) {
  if (!values || values.length < 2) return null
  return values[values.length - 1] - values[0]
}

/** Whole minutes since an ISO timestamp, or null when it is missing or invalid. */
export function minutesSince(iso, now = Date.now()) {
  if (!iso) return null
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return null
  return Math.max(0, Math.floor((now - time) / 60000))
}

/** "12 min", "3 h", "2 d" for the prices-updated footnote. */
export function shortAge(minutes) {
  if (minutes == null) return null
  if (minutes < 1) return '<1 min'
  if (minutes < 60) return `${minutes} min`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} h`
  return `${Math.floor(minutes / (60 * 24))} d`
}
