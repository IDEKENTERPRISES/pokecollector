// The weekly challenge's pure helpers (docs/SOCIAL_DESIGN.md §7): week numbers, the countdown, finish
// times in the trainer's own time zone, places and the sentences built from them. Tested in
// challengeFormat.test.js.

export const CHALLENGE_QUERY_KEY = ['challenge']

const PLACE_KEYS = { 1: 'placeFirst', 2: 'placeSecond', 3: 'placeThird' }

/** The i18n key (under `challenge.`) of "1st", "2nd" or "3rd"; null for any other place. */
export const placeKey = place => PLACE_KEYS[place] ?? null

/** "2026-W44" gives 44. */
export function weekNumber(key) {
  const match = /W(\d{1,2})$/.exec(String(key ?? ''))
  return match ? Number(match[1]) : null
}

/** How long until `endsAt`: whole days, else whole hours, else minutes (at least 1); 'ended' once past. */
export function timeLeft(endsAt, now = Date.now()) {
  const end = new Date(endsAt).getTime()
  if (!Number.isFinite(end)) return null
  const ms = end - now
  if (ms <= 0) return { unit: 'ended', count: 0 }
  const day = 24 * 3600 * 1000
  if (ms >= day) return { unit: 'days', count: Math.floor(ms / day) }
  const minutes = Math.ceil(ms / 60000)
  if (minutes >= 60) return { unit: 'hours', count: Math.floor(minutes / 60) }
  return { unit: 'minutes', count: Math.max(1, minutes) }
}

/** The i18n key (under `challenge.`) and count for a countdown result. */
export function leftKey(left) {
  if (!left) return null
  if (left.unit === 'ended') return { key: 'leftEnded', count: 0 }
  const name = left.unit === 'days' ? 'Day' : left.unit === 'hours' ? 'Hour' : 'Minute'
  return { key: `left${name}${left.count === 1 ? 'One' : 's'}`, count: left.count }
}

/**
 * "Tue 21:14" (or "Tuesday 21:14" with `long`) in the device's time zone, 24-hour. Null for no date.
 * The server sends UK time with its offset, so the deadline and the finish times read on the trainer's own clock.
 */
export function formatWhen(iso, locale, { long = false } = {}) {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  let parts
  try {
    parts = new Intl.DateTimeFormat(locale || undefined, {
      weekday: long ? 'long' : 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date)
  } catch {
    return null
  }
  const pick = type => parts.find(part => part.type === type)?.value ?? ''
  return `${pick('weekday')} ${pick('hour')}:${pick('minute')}`
}

/** 0..1 of the way to the target, safe for a missing or zero target. */
export function fractionOf(progress, target) {
  const done = Number(progress)
  const goal = Number(target)
  if (!Number.isFinite(done) || !Number.isFinite(goal) || goal <= 0) return 0
  return Math.min(1, Math.max(0, done / goal))
}

/** Trainers who finished, in finishing order, without the viewer. */
export function finishersOf(board, viewerId) {
  return (Array.isArray(board) ? board : [])
    .filter(entry => entry?.finished_at && entry.user?.id !== viewerId)
    .sort((a, b) => new Date(a.finished_at) - new Date(b.finished_at))
}

/** Three podium slots (places 1 to 3): the entry that holds each place, else null. */
export function podiumSlots(entries) {
  const list = Array.isArray(entries) ? entries : []
  return [1, 2, 3].map(place => ({ place, entry: list.find(entry => entry?.place === place) ?? null }))
}

/** Whether anybody on the board has started: the podium and the board stay hidden until then. */
export function anyoneStarted(board) {
  return (Array.isArray(board) ? board : []).some(entry => Number(entry?.progress) > 0)
}

/** The number in a badge id: "challenge_5" gives 5. */
export function badgeCount(id) {
  const match = /(\d+)$/.exec(String(id ?? ''))
  return match ? Number(match[1]) : null
}

/** Which line the result card shows for the viewer: finished, placed, reached or none. */
export function resultLine(me) {
  if (!me) return { kind: 'reached', progress: 0 }
  if (me.finished_at) return { kind: me.place ? 'finishedPlace' : 'finished', place: me.place }
  if (me.place) return { kind: 'placed', place: me.place, progress: me.progress }
  return { kind: 'reached', progress: me.progress }
}
