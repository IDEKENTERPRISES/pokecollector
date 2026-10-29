// Pure helpers for the Wrapped story (engagement P9b, redesigned in P9c): which slides show, the
// persona and rarity, and the numbers behind the charts. Both the slides and the share pictures use them.
import { typeKeyFor } from '../components/ios/pokemon'
import { PERSONA_MIN_CARDS, rarityFor } from './theme'

export const SLIDE_MS = 6000

/** Slide ids in story order. */
export const SLIDE_ORDER = [
  'cover', 'cards', 'first', 'pull', 'favourites', 'sets', 'value', 'streak', 'badges', 'summary',
]

/** The year Home and Profile ask for: January still belongs to last year's Wrapped (it runs to 15 January). */
export function wrappedYearFor(now = new Date()) {
  return now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear()
}

export const parseYear = (value, fallback) => {
  const year = Number.parseInt(value, 10)
  return Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : fallback
}

const num = value => (Number.isFinite(Number(value)) ? Number(value) : 0)

/** True when the account's history starts inside the year (so the cover says "since you started"). */
export function startsInYear(data) {
  const start = data?.history_starts
  if (!start || !data.year) return false
  const [year, month, day] = String(start).split('-').map(Number)
  return year === data.year && !(month === 1 && day === 1)
}

/**
 * The slides to play, in order. A slide whose data is empty is skipped; the cover and summary always stay.
 * `showDaily` is the "Show streaks and quests" switch: with it off the streak slide goes.
 */
export function selectSlides(data, { showDaily = true } = {}) {
  if (!data) return []
  const totals = data.totals || {}
  const has = {
    cover: true,
    cards: num(totals.cards) > 0,
    first: Boolean(data.first_card),
    pull: Boolean(data.best_pull),
    favourites: Boolean(data.top_pokemon || data.top_type || data.top_illustrator),
    sets: num(totals.sets_completed) > 0 || Boolean(data.closest_set),
    value: Boolean(data.value),
    streak: showDaily && (num(data.longest_streak) > 0 || num(data.wtp_wins) > 0 || num(data.quests_done) > 0),
    badges: num(data.badges_earned) > 0 || num(data.trades?.count) > 0 || num(data.products?.count) > 0,
    summary: true,
  }
  return SLIDE_ORDER.filter(id => has[id])
}

const localDate = iso => {
  const [year, month, day] = String(iso || '').split('-').map(Number)
  return year && month && day ? new Date(year, month - 1, day) : null
}

export function dayMonth(iso, locale) {
  const date = localDate(iso)
  return date ? date.toLocaleDateString(locale || undefined, { day: 'numeric', month: 'long' }) : ''
}

export function monthName(month, locale, style = 'long') {
  try {
    return new Date(2000, month - 1, 1).toLocaleDateString(locale || undefined, { month: style })
  } catch {
    return String(month)
  }
}

/** "+€5" / "−€5": the sign goes outside the formatted amount, which the caller may have masked. */
export const signed = (change, formatted) => (!change ? formatted : `${change > 0 ? '+' : '−'}${formatted}`)

export const thousands = (value, locale) => num(value).toLocaleString(locale || undefined)

/** Share of the year's cards in the top type, as a whole percent (0 when unknown). */
export function typePercent(data) {
  const top = data?.top_type
  const total = num(data?.totals?.cards)
  if (top?.percent != null) return Math.round(num(top.percent))
  return top && total > 0 ? Math.round((num(top.count) / total) * 100) : 0
}

/** The collection's top energy type as a palette key, or null. */
export function topTypeKey(data) {
  return data?.top_type ? (typeKeyFor(data.top_type.type) || 'colorless') : null
}

/** The trainer type (§3.5): the top type once the year has at least 10 cards, else null. */
export function personaKey(data) {
  return num(data?.totals?.cards) >= PERSONA_MIN_CARDS ? topTypeKey(data) : null
}

export const rarityOf = data => rarityFor(data?.totals?.cards)

/** "004" for the collector strip. */
export const pad3 = n => String(Math.max(0, Math.floor(num(n)))).padStart(3, '0')

/** The month the history starts in (1–12) when it starts inside the year, else null. */
export function startMonth(data) {
  return startsInYear(data) ? Number(String(data.history_starts).split('-')[1]) : null
}

/**
 * The 12 month columns of the cards chart. Months before the history starts are `untracked`
 * (drawn as dashed outlines, §6), the rest scale to the biggest month. `few` is true below 12
 * cards, when the chart becomes a row of one pip per card (§6). Null without monthly counts.
 */
export function monthCells(data) {
  const counts = data?.monthly
  if (!Array.isArray(counts) || counts.length !== 12) return null
  const values = counts.map(num)
  const max = Math.max(...values)
  if (max <= 0) return null
  const from = startMonth(data)
  const biggest = data.biggest_month?.month ? data.biggest_month.month - 1 : values.indexOf(max)
  const cells = values.map((count, index) => ({
    index,
    count,
    untracked: Boolean(from && index + 1 < from && count === 0),
    top: index === biggest,
    ratio: count / max,
  }))
  return { cells, max, few: values.reduce((a, b) => a + b, 0) < 12 }
}

/** "5 weeks and 6 days" parts of a streak. */
export const weeksAndDays = days => ({ weeks: Math.floor(num(days) / 7), days: num(days) % 7 })

/**
 * Money the way the mockups write it: whole amounts under 1,000 ("£182"), then three significant
 * figures ("£1.4k", "£1.52k", "£12.3k", "£1.2M"). With hide-values on every amount is "£•••".
 */
export function wrappedMoney({ symbol = '€', rate = 1, hidden = false } = {}) {
  return amount => {
    if (hidden) return `${symbol}•••`
    const value = Math.abs(num(amount) * rate)
    const trim = text => (text.includes('.') ? text.replace(/\.?0+$/, '') : text)
    if (value < 1000) return `${symbol}${Math.round(value)}`
    if (value < 1e6) return `${symbol}${trim((value / 1000).toPrecision(3))}k`
    return `${symbol}${trim((value / 1e6).toPrecision(3))}M`
  }
}

/**
 * The value chart in the mockup's 344 × 310 box: points from the first tracked month to the
 * last (x 10–334, y 270 at the lowest value up to 50 at the highest), month ticks every other
 * month, and the peak. Uses `series` when the API sends it, else start, peak and end.
 */
export function valueChart(value) {
  const series = Array.isArray(value?.series) && value.series.length
    ? value.series.map(point => ({ month: num(point.month), value: num(point.value) }))
    : null
  const monthOf = iso => Number(String(iso || '').split('-')[1]) || null
  const points = series || [
    { month: monthOf(value?.start_date) || 1, value: num(value?.start) },
    { month: monthOf(value?.peak_date) || 6, value: num(value?.peak) },
    { month: 12, value: num(value?.end) },
  ].sort((a, b) => a.month - b.month)
  const first = points[0].month
  const last = Math.max(points.at(-1).month, first + 1)
  const values = points.map(p => p.value)
  const min = Math.min(...values)
  const span = Math.max(...values) - min || 1
  const xy = points.map(p => ({
    ...p,
    x: Math.round(10 + ((p.month - first) / (last - first)) * 324),
    y: Math.round(270 - ((p.value - min) / span) * 220),
  }))
  if (xy.length === 1) xy.push({ ...xy[0], x: 334 })
  const peak = xy.reduce((best, p, i) => (p.value > xy[best].value ? i : best), 0)
  const ticks = []
  for (let m = first; m <= last; m += 2) ticks.push({ month: m, x: Math.round(10 + ((m - first) / (last - first)) * 324) })
  return { points: xy, peak, ticks, first, last }
}
