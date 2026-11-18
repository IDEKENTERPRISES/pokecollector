// Data epoch: how a phone learns that an administrator wiped all user data (Settings > Administrator).
//
// `GET /api/health` carries `data_epoch`, a random id the server replaces on every wipe. The device stores the
// one it last saw. When the server's differs, everything this device holds for the old accounts is stale and
// dangerous: queued writes (the outbox) would be replayed into the fresh database, and the saved pages and
// preferences describe people who no longer exist. So the device, without replaying anything:
//   - stops the outbox and drops its database (queued items are deleted, never sent),
//   - clears the saved pages, viewed pictures, settings and sign-in caches (clearAllUserData),
//   - clears the query cache and every locally stored preference (localStorage, sessionStorage),
//   - and goes to the login screen.
// It also covers a phone that was offline during the wipe and comes back days later: the first answer from the
// server carries the new epoch. The downloaded card database (cards, sets, prices, pictures) is not user data
// and stays. A device that never stored an epoch (it last ran before this feature) stores the first one it
// sees; its old session is rejected by the server anyway, because the wipe ended every session.

import { clearAllUserData } from './sessionCleanup.js'

export const DATA_EPOCH_KEY = 'pc.dataEpoch.v1'

function defaultStorage(kind = 'localStorage') {
  try {
    return globalThis[kind] ?? null
  } catch {
    return null
  }
}

/** The epoch this device stored, or null. */
export function readStoredEpoch(storage = defaultStorage()) {
  try {
    return storage?.getItem(DATA_EPOCH_KEY) || null
  } catch {
    return null
  }
}

export function writeStoredEpoch(epoch, storage = defaultStorage()) {
  try {
    storage?.setItem(DATA_EPOCH_KEY, epoch)
  } catch {
    // best effort
  }
}

/**
 * 'unknown' the server sent no epoch (an older server, or it could not read it): do nothing.
 * 'first'   nothing stored yet: remember this one.
 * 'same'    nothing changed.
 * 'wiped'   the server's data was wiped since this device last saw it.
 */
export function judgeEpoch(stored, server, { wipedAt = null, holdsUserData = false } = {}) {
  if (typeof server !== 'string' || server === '') return 'unknown'
  // No epoch stored: a device from before this feature, or one that never saw the server. If the server was
  // wiped at some point and this device holds anything user-specific, it may belong to the old accounts.
  if (!stored) return wipedAt && holdsUserData ? 'wiped' : 'first'
  return stored === server ? 'same' : 'wiped'
}

/** True for an outbox item that must never be sent: queued in another epoch, or unstamped on a server that was wiped. */
export function isStaleItem(item, serverEpoch, wipedAt) {
  if (typeof serverEpoch !== 'string' || serverEpoch === '') return false
  if (item?.dataEpoch) return item.dataEpoch !== serverEpoch
  return Boolean(wipedAt)
}

const OUTBOX_DB = 'pokecollector-outbox'
const READ_CACHE_DB = 'pokecollector-readcache'

async function listDatabaseNames() {
  try {
    const list = await globalThis.indexedDB?.databases?.()
    return Array.isArray(list) ? list.map(entry => entry.name) : null
  } catch {
    return null
  }
}

/**
 * Whether this device holds anything user-specific: a stored sign-in, or the outbox / saved-pages databases.
 * Those databases are only created by a signed-in user, so their presence is enough (a false "yes" only costs
 * one sign-in; a false "no" would replay old writes into a new account).
 */
export async function deviceHoldsUserData({ storage = defaultStorage(), listDatabases = listDatabaseNames } = {}) {
  try {
    if (storage?.getItem('token') || storage?.getItem('user')) return true
  } catch {
    // unreadable storage counts as empty
  }
  const names = await listDatabases()
  return Boolean(names?.some(name => name === OUTBOX_DB || name === READ_CACHE_DB))
}

const listeners = new Set()

/** Registers cleanup that must run first on a wipe (stop the outbox, stop the cache saver, clear the query cache). */
export function onDataWiped(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

let running = null

/**
 * Clears everything user-specific from this device, then stores the new epoch and goes to the login screen.
 * Never throws and never replays the outbox. Every step is guarded so a failing one cannot keep the old token.
 */
export async function wipeLocalData(serverEpoch, {
  storage = defaultStorage('localStorage'),
  session = defaultStorage('sessionStorage'),
  clearAll = clearAllUserData,
  redirect = () => globalThis.location?.replace('/login'),
  extraListeners = listeners,
} = {}) {
  for (const listener of [...extraListeners]) {
    try {
      await listener()
    } catch {
      // cleanup is best effort
    }
  }
  try {
    await clearAll({ keepOutbox: false })
  } catch {
    // the guarded steps inside already swallow their errors
  }
  try {
    storage?.clear()
  } catch {
    try {
      for (const key of Object.keys(storage ?? {})) storage.removeItem(key)
    } catch {
      // nothing more to do
    }
  }
  try {
    session?.clear()
  } catch {
    // best effort
  }
  writeStoredEpoch(serverEpoch, storage)
  try {
    redirect()
  } catch {
    // best effort
  }
}

/**
 * Looks at the epoch of one server answer. → the verdict ('unknown' | 'first' | 'same' | 'wiped').
 * On 'wiped' it waits for the local cleanup (once, however many callers ask at the same time).
 */
export async function observeDataEpoch(serverEpoch, options = {}) {
  const storage = options.storage ?? defaultStorage('localStorage')
  const stored = readStoredEpoch(storage)
  const wipedAt = options.wipedAt ?? null
  const holdsUserData = !stored && wipedAt && typeof serverEpoch === 'string' && serverEpoch
    ? await (options.holdsUserData ?? deviceHoldsUserData)({ storage })
    : false
  const verdict = judgeEpoch(stored, serverEpoch, { wipedAt, holdsUserData })
  if (verdict === 'first') writeStoredEpoch(serverEpoch, storage)
  if (verdict !== 'wiped') return verdict
  if (!running) {
    running = wipeLocalData(serverEpoch, { ...options, storage }).finally(() => { running = null })
  }
  await running
  return verdict
}

/**
 * Wraps a reachability probe: when the server answers with a different epoch the device is wiped and the probe
 * reports "unreachable", so a replay that was about to start sends nothing.
 */
export function guardProbeWithEpoch(probeImpl, observe = observeDataEpoch) {
  return async (...args) => {
    const result = await probeImpl(...args)
    if (result?.state === 'reachable') {
      const verdict = await observe(result.serverInfo?.dataEpoch ?? null, { wipedAt: result.serverInfo?.dataWipedAt ?? null })
      if (verdict === 'wiped') return { state: 'unreachable' }
    }
    return result
  }
}

/**
 * Checks the epoch at start and whenever the app returns or the connection comes back, whether or not the
 * offline queue is on. → stop function.
 */
export function startDataEpochWatch({ probe, observe = observeDataEpoch, target = globalThis } = {}) {
  let stopped = false
  const check = async () => {
    if (stopped) return
    try {
      const result = await probe()
      if (!stopped && result?.state === 'reachable') await observe(result.serverInfo?.dataEpoch ?? null, { wipedAt: result.serverInfo?.dataWipedAt ?? null })
    } catch {
      // unreachable servers are the outbox monitor's business
    }
  }
  const onVisible = () => {
    if (target.document?.visibilityState !== 'hidden') check()
  }
  check()
  target.addEventListener?.('online', check)
  target.addEventListener?.('pageshow', check)
  target.document?.addEventListener?.('visibilitychange', onVisible)
  return () => {
    stopped = true
    target.removeEventListener?.('online', check)
    target.removeEventListener?.('pageshow', check)
    target.document?.removeEventListener?.('visibilitychange', onVisible)
  }
}
