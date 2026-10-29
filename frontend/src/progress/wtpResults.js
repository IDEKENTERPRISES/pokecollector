import { postWtpAnswer } from '../api/client'
import { markSent, pendingResults } from './daily'

const flushing = new Set()

/** Sends the results kept on this device that the server has not accepted yet. Quiet; never throws. */
export async function flushWtpResults(userId, { post = postWtpAnswer } = {}) {
  if (typeof userId !== 'number' || flushing.has(userId)) return 0
  if (globalThis.navigator?.onLine === false) return 0
  flushing.add(userId)
  let sent = 0
  try {
    for (const { date, choice } of pendingResults(userId)) {
      try {
        await post(date, choice)
        markSent(userId, date)
        sent += 1
      } catch (error) {
        // A refused date (too old) can never be accepted; anything else is retried next time.
        if (error?.response?.status === 400) markSent(userId, date)
        else break
      }
    }
  } finally {
    flushing.delete(userId)
  }
  return sent
}
