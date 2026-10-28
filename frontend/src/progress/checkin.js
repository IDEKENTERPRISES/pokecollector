import api from '../api/client'

// Daily check-in (engagement P1): tells the server the phone's time zone and the local days the app
// was opened. Dates queue in localStorage per user, so offline opens are replayed later. It is
// silent: an error never reaches the UI and nothing here is awaited by start-up.
const MAX_DATES = 14
const MAX_AGE_DAYS = 13
const keyFor = userId => `progress.checkin.pending.${userId}`

const pad = n => String(n).padStart(2, '0')
export const localDateString = (now = new Date()) =>
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

const shiftDays = (dateString, days) => {
  const [y, m, d] = dateString.split('-').map(Number)
  return localDateString(new Date(y, m - 1, d + days))
}

export function readPending(userId) {
  try {
    const parsed = JSON.parse(localStorage.getItem(keyFor(userId)) || '[]')
    return Array.isArray(parsed) ? parsed.filter(v => /^\d{4}-\d{2}-\d{2}$/.test(v)) : []
  } catch {
    return []
  }
}

function writePending(userId, dates) {
  try {
    if (dates.length === 0) localStorage.removeItem(keyFor(userId))
    else localStorage.setItem(keyFor(userId), JSON.stringify(dates))
  } catch {
    // storage unavailable: the check-in is best effort
  }
}

/** Adds today's local date to the user's pending list, dropping dates the server would refuse. */
export function queueToday(userId, now = new Date()) {
  const today = localDateString(now)
  const oldest = shiftDays(today, -MAX_AGE_DAYS)
  const dates = [...new Set([...readPending(userId), today])]
    .filter(date => date >= oldest && date <= shiftDays(today, 1))
    .sort()
    .slice(-MAX_DATES)
  writePending(userId, dates)
  return dates
}

const inFlight = new Set()

/** Queues today and sends the pending dates when online. Resolves quietly whatever happens. */
export async function checkIn(userId, { now = new Date(), client = api } = {}) {
  if (typeof userId !== 'number') return
  try {
    const dates = queueToday(userId, now)
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    if (inFlight.has(userId)) return
    inFlight.add(userId)
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (!timeZone) return
      await client.post('/progress/checkin', { time_zone: timeZone, dates })
      // Keep only dates queued while the request was running.
      const sent = new Set(dates)
      writePending(userId, readPending(userId).filter(date => !sent.has(date)))
    } catch (error) {
      // The server refused the batch (bad date or zone): retrying the same batch can never work.
      if (error?.response?.status === 400) writePending(userId, [])
    } finally {
      inFlight.delete(userId)
    }
  } catch {
    // never surface a check-in problem
  }
}
