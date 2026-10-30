// Pure helpers for the activity feed (docs/SOCIAL_DESIGN.md §6), kept free of React so they are unit-tested.

export const REACTION_ORDER = ['cheer', 'wow', 'fire', 'heart']
export const COMMENT_MAX_LENGTH = 280
// Mirrors services/progress/state.py BIG_PULL_EUR (the sharing sheet quotes it).
export const BIG_PULL_EUR = 20

// The per-kind sharing switches, in the order of the sharing sheet. `key` is the user setting.
export const SHARE_ROWS = [
  { kind: 'set_completed', key: 'feed_share_set_completed', fallback: true },
  { kind: 'achievement_unlocked', key: 'feed_share_achievement_unlocked', fallback: true },
  { kind: 'big_pull', key: 'feed_share_big_pull', fallback: false },
  { kind: 'goal_completed', key: 'feed_share_goal_completed', fallback: false },
  // P13 adds this key; the row shows once the server reports it.
  { kind: 'challenge_finished', key: 'feed_share_challenge_finished', fallback: true, needsServerKey: true },
]
export const SHARE_VALUES_KEY = 'feed_share_values'
export const CHALLENGE_BOARD_KEY = 'challenge_on_board'
export const INTRO_SEEN_KEY = 'feed_intro_seen'

export const isOn = (settings, key, fallback = false) => {
  const value = settings?.[key]
  if (value === undefined || value === null) return fallback
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase())
}

const pad = n => String(n).padStart(2, '0')
const clock = date => `${pad(date.getHours())}:${pad(date.getMinutes())}`
const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate())
const dayGap = (now, then) => Math.round((startOfDay(now) - startOfDay(then)) / 86400000)

/** "Mon" for a date, in the user's language. */
function weekdayShort(date, locale) {
  return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date)
}

/** "26 Oct" in the app's day-month order, whatever the browser's region. */
function dayMonth(date, locale) {
  return `${date.getDate()} ${new Intl.DateTimeFormat(locale, { month: 'short' }).format(date)}`
}

/** Group header: "Today", "Yesterday", then "Mon 26 Oct". */
export function dayLabel(iso, t, now = new Date(), locale) {
  const date = new Date(iso)
  const gap = dayGap(now, date)
  if (gap <= 0) return t('feed.today')
  if (gap === 1) return t('feed.yesterday')
  return `${weekdayShort(date, locale)} ${dayMonth(date, locale)}`
}

/**
 * The age under an event's sentence: "2 h ago" today, "Yesterday at 20:14", "Mon at 19:40" within
 * a week, "26 Oct at 19:40" after that. `spoken` writes the hours out for VoiceOver.
 */
export function ageLabel(iso, t, { now = new Date(), spoken = false, locale } = {}) {
  const date = new Date(iso)
  const gap = dayGap(now, date)
  const minutes = Math.max(0, Math.floor((now - date) / 60000))
  if (gap <= 0) {
    if (minutes < 1) return t('feed.justNow')
    if (minutes < 60) return t(spoken ? 'feed.minutesAgoSpoken' : 'feed.minutesAgo').replace('{count}', minutes)
    return t(spoken ? 'feed.hoursAgoSpoken' : 'feed.hoursAgo').replace('{count}', Math.floor(minutes / 60))
  }
  if (spoken && gap === 1) return t('feed.yesterday')
  const when = gap === 1 ? t('feed.yesterday') : gap < 7 ? weekdayShort(date, locale) : dayMonth(date, locale)
  return t('feed.dayAt').replace('{day}', when).replace('{time}', clock(date))
}

/** Items in server order, split into day groups: [{ label, items }]. */
export function groupByDay(items, t, now = new Date(), locale) {
  const groups = []
  for (const item of items) {
    const label = dayLabel(item.occurred_at, t, now, locale)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(item)
    else groups.push({ label, items: [item] })
  }
  return groups
}

/** The set page for a feed set key ("sv08_en" → "sv08"). */
export function setPathFor(display) {
  const key = String(display?.set_key ?? '')
  const lang = display?.lang
  const id = lang && key.endsWith(`_${lang}`) ? key.slice(0, -(lang.length + 1)) : key
  return id ? `/sets/${encodeURIComponent(id)}` : null
}

/** What a reaction tap does to `{ counts, mine }` before the server answers. Returns a new object. */
export function toggleReaction(reactions, kind) {
  const mine = new Set(reactions?.mine ?? [])
  const counts = { ...(reactions?.counts ?? {}) }
  if (mine.has(kind)) {
    mine.delete(kind)
    counts[kind] = Math.max(0, (counts[kind] ?? 0) - 1)
  } else {
    mine.add(kind)
    counts[kind] = (counts[kind] ?? 0) + 1
  }
  return { counts, mine: REACTION_ORDER.filter(k => mine.has(k)) }
}

/** "Cheer, 2, you reacted" / "Wow" / "Fire, 1". */
export function reactionLabel(name, count, reacted, t) {
  const parts = [name]
  if (count > 0) parts.push(String(count))
  if (reacted) parts.push(t('feed.youReacted'))
  return parts.join(', ')
}

/** "2 cheers, 1 love it" for the summary VoiceOver reads on your own events (their buttons are not buttons). */
export function reactionSummary(counts, t) {
  return REACTION_ORDER
    .filter(kind => (counts?.[kind] ?? 0) > 0)
    .map(kind => t(counts[kind] === 1 ? `feed.reactionSummary.${kind}One` : `feed.reactionSummary.${kind}`).replace('{count}', counts[kind]))
    .join(', ')
}

/** Trim a draft the way the server does; null when it can't be sent. */
export function cleanComment(text) {
  const cleaned = String(text ?? '').trim()
  if (!cleaned || cleaned.length > COMMENT_MAX_LENGTH) return null
  return cleaned
}

/** The tail that decides which state the feed segment shows. */
export function feedState({ offline, isLoading, error, itemCount }) {
  if (offline && itemCount === 0) return 'offline'
  if (isLoading) return 'loading'
  if (error && itemCount === 0) return 'error'
  if (itemCount === 0) return 'empty'
  return 'list'
}
