// Pure helpers for the Wrapped story (engagement P9b): which slides show, formatting and the share picture.
import { fill } from '../delights/delights'
import { blocksSpec } from '../progress/shareImage'

export const SLIDE_MS = 6000
export const WRAPPED_SHARE_FILE = 'wrapped.png'

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

/** Bars for the month chart. Needs the 12 monthly counts; without them the chart is left out. */
export function monthBars(data) {
  const counts = data?.monthly
  if (!Array.isArray(counts) || counts.length !== 12) return null
  const values = counts.map(num)
  const max = Math.max(...values)
  if (max <= 0) return null
  const biggest = data.biggest_month?.month ? data.biggest_month.month - 1 : values.indexOf(max)
  return values.map((count, index) => ({
    index, count, height: Math.max(3, Math.round((count / max) * 100)), top: index === biggest,
  }))
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

/** Points (0..1) for the value chart: the real series when the API sends one, else start, peak and end. */
export function valuePoints(value) {
  const series = Array.isArray(value?.series) ? value.series.map(point => num(point.value)) : []
  const values = series.length >= 2 ? series : [num(value?.start), num(value?.peak), num(value?.end)]
  const min = Math.min(...values)
  const span = Math.max(...values) - min || 1
  return values.map((v, index) => ({ x: values.length === 1 ? 0 : index / (values.length - 1), y: (v - min) / span }))
}

/** The picture's blocks, as for the weekly recap (progress/shareImage blocksSpec). Amounts are flagged for masking. */
export function wrappedBlocks({ data, t, money, locale, showDaily }) {
  const totals = data.totals || {}
  const blocks = [{ type: 'number', value: thousands(totals.cards, locale), label: t('wrapped.sharedCards') }]
  if (data.best_pull) {
    blocks.push({
      type: 'card',
      url: data.best_pull.image,
      label: num(data.best_pull.price) > 0 ? `${data.best_pull.name} · ${money(data.best_pull.price)}` : data.best_pull.name,
      amount: num(data.best_pull.price) > 0,
    })
  }
  if (data.top_pokemon) {
    blocks.push({ type: 'line', text: fill(t('wrapped.sharedPokemon'), { name: data.top_pokemon.name }) })
  }
  const sets = num(totals.sets_completed)
  const streak = showDaily ? num(data.longest_streak) : 0
  if (sets > 0 || streak > 0) {
    const parts = []
    if (sets > 0) parts.push(fill(t(sets === 1 ? 'wrapped.sharedSetsOne' : 'wrapped.sharedSets'), { count: sets }))
    if (streak > 0) parts.push(fill(t('wrapped.sharedStreak'), { count: streak }))
    blocks.push({ type: 'line', text: parts.join(' · ') })
  }
  if (data.value) {
    blocks.push({ type: 'line', text: fill(t('wrapped.sharedValue'), { amount: money(data.value.end) }), amount: true })
  }
  if (num(data.badges_earned) > 0) {
    blocks.push({ type: 'line', text: fill(t('wrapped.sharedBadges'), { count: data.badges_earned }) })
  }
  return blocks
}

export function wrappedShareSpec({ data, t, money, locale, showDaily, hideValues, name, accent, fontFamily }) {
  return blocksSpec({
    format: 'story',
    appName: t('wtp.shareApp'),
    title: fill(t('wrapped.shareTitle'), { year: data.year }),
    subtitle: name || '',
    blocks: wrappedBlocks({ data, t, money, locale, showDaily }),
    hideValues,
    accent,
    fontFamily,
  })
}
