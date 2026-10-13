// Collection `acquired_at` values are naive UTC timestamps ("2025-03-04T21:15:00");
// the API defaults them to `added_at` until the owner picks their own date. Dates
// are read straight from the string so the day shown never shifts with the
// viewer's timezone, and matches what the <input type="date"> edits.

export function acquiredDateInputValue(addedAt) {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(addedAt || ''))
  return match ? match[1] : ''
}

export function formatAcquiredDate(addedAt, locale) {
  const value = acquiredDateInputValue(addedAt)
  if (!value) return null
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  try {
    return new Intl.DateTimeFormat(locale || undefined, { dateStyle: 'medium' }).format(date)
  } catch {
    // An unrecognised locale tag should not break the page.
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
  }
}

// The oldest acquired date across every owned version of each card, keyed by card_id.
// A card's versions (variant / condition / language rows) share one "first acquired" date.
export function oldestAcquiredByCard(items) {
  const oldest = new Map()
  for (const item of items || []) {
    const value = acquiredDateInputValue(item?.acquired_at ?? item?.added_at)
    if (!value || !item?.card_id) continue
    const current = oldest.get(item.card_id)
    if (!current || value < current) oldest.set(item.card_id, value)
  }
  return oldest
}

export function todayInputValue() {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}
