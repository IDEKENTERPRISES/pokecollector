// Where the tour is marked done (docs/WELCOME_DESIGN.md §3.10). The server keeps it per account; this device keeps
// a copy in localStorage so the tour does not repeat while offline, and sends it later if the first send failed.
import { clearTutorialDone, setTutorialDone } from '../api/client'

export const NEW_ACCOUNT_DAYS = 2

const key = userId => `pc.tour.done.${userId}`

export function readLocalDone(userId, storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(key(userId))
    if (!raw) return null
    const record = JSON.parse(raw)
    return record && record.outcome ? record : null
  } catch {
    return null
  }
}

function writeLocalDone(userId, record, storage = globalThis.localStorage) {
  try {
    storage?.setItem(key(userId), JSON.stringify(record))
  } catch {
    // the server copy still stops the tour
  }
}

export function clearLocalDone(userId, storage = globalThis.localStorage) {
  try {
    storage?.removeItem(key(userId))
  } catch {
    // ignore
  }
}

/** Done on the server or on this device. */
export function tourIsDone(user, storage) {
  if (!user) return true
  return Boolean(user.tutorial_completed_at) || Boolean(readLocalDone(user.id, storage))
}

/** A new account starts the tour by itself; an older one gets the Take the tour card (§3.1). */
export function isNewAccount(user, now = Date.now()) {
  const created = Date.parse(user?.created_at ?? '')
  if (!Number.isFinite(created)) return false
  return now - created < NEW_ACCOUNT_DAYS * 24 * 3600 * 1000
}

/**
 * Mark the tour done: locally at once, then on the server. A failed send is kept and retried by
 * `syncTourDone` (on the next start and when the device comes back online).
 */
export async function recordTourDone(user, outcome, onUser, now = new Date()) {
  const at = now.toISOString()
  writeLocalDone(user.id, { outcome, at, synced: false })
  onUser?.({ tutorial_completed_at: at, tutorial_outcome: outcome })
  return syncTourDone(user, onUser)
}

export async function syncTourDone(user, onUser) {
  const record = readLocalDone(user.id)
  if (!record || record.synced) return false
  try {
    const result = await setTutorialDone(record.outcome, record.at)
    writeLocalDone(user.id, { ...record, synced: true })
    onUser?.({ tutorial_completed_at: result.tutorial_completed_at, tutorial_outcome: result.tutorial_outcome })
    return true
  } catch {
    return false
  }
}

/** "Show the tour again": forget the completion on the server and on this device. */
export async function resetTourDone(user, onUser) {
  await clearTutorialDone()
  clearLocalDone(user.id)
  onUser?.({ tutorial_completed_at: null, tutorial_outcome: null })
}
