// The daily loop's device-side rules (engagement P7): the "Show streaks and quests" switch, the
// Who's That Pokémon results kept per user, and the Wordle-style share text. Pure and unit-tested.

export const SHOW_DAILY_KEY = 'pc.progress.showDaily.v1'
const RESULTS_KEY = userId => `pc.wtp.results.${userId}`
const KEEP_RESULTS = 30
const DATE = /^\d{4}-\d{2}-\d{2}$/

function attempt(run, fallback = null) {
  try {
    return run()
  } catch {
    return fallback
  }
}

/** Streaks and quests are on unless the trainer switched them off on this device. */
export function readShowDaily(storage = globalThis.localStorage) {
  return attempt(() => storage?.getItem(SHOW_DAILY_KEY)) !== '0'
}

export function writeShowDaily(enabled, storage = globalThis.localStorage) {
  attempt(() => storage?.setItem(SHOW_DAILY_KEY, enabled ? '1' : '0'))
}

export function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number)
  const next = new Date(y, m - 1, d + days)
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`
}

/** { 'YYYY-MM-DD': { choice, correct, sent } } for the user. */
export function readResults(userId, storage = globalThis.localStorage) {
  const parsed = attempt(() => JSON.parse(storage?.getItem(RESULTS_KEY(userId)) || '{}'), {})
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return Object.fromEntries(Object.entries(parsed).filter(([date, value]) => (
    DATE.test(date) && value && Number.isInteger(value.choice) && typeof value.correct === 'boolean'
  )))
}

function writeResults(userId, results, storage) {
  const kept = Object.fromEntries(Object.entries(results).sort(([a], [b]) => a.localeCompare(b)).slice(-KEEP_RESULTS))
  attempt(() => storage?.setItem(RESULTS_KEY(userId), JSON.stringify(kept)))
  return kept
}

/** Keep the trainer's one try for a date. A second answer for the same date is ignored. */
export function recordResult(userId, date, { choice, correct }, storage = globalThis.localStorage) {
  const results = readResults(userId, storage)
  if (results[date]) return results[date]
  results[date] = { choice, correct: Boolean(correct), sent: false }
  writeResults(userId, results, storage)
  return results[date]
}

export function markSent(userId, date, storage = globalThis.localStorage) {
  const results = readResults(userId, storage)
  if (!results[date]) return
  results[date] = { ...results[date], sent: true }
  writeResults(userId, results, storage)
}

/** Results not yet accepted by the server, oldest first: [{ date, choice, correct }]. */
export function pendingResults(userId, storage = globalThis.localStorage) {
  return Object.entries(readResults(userId, storage))
    .filter(([, value]) => !value.sent)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, choice: value.choice, correct: value.correct }))
}

/** 🟩 right, 🟥 wrong, ⬜ not played: the last `days` days ending on `date`. */
export function resultGrid(results, date, days = 7) {
  return Array.from({ length: days }, (_, index) => {
    const entry = results[shiftDate(date, index - (days - 1))]
    if (!entry) return '⬜'
    return entry.correct ? '🟩' : '🟥'
  }).join('')
}

/** The text the Share button sends. `t` is the app's translator. */
export function shareText({ t, date, results, streak = 0 }) {
  const entry = results[date]
  const lines = [
    `${t('wtp.shareTitle')} ${date}`,
    `${resultGrid(results, date)} ${entry?.correct ? t('wtp.shareWon') : t('wtp.shareLost')}`,
  ]
  if (streak > 0) lines.push(`🔥 ${t('today.streakDays').replace('{count}', streak)}`)
  return lines.join('\n')
}
