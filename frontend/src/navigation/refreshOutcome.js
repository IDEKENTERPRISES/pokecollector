// Decisions for pull to refresh that need no DOM, so they can be unit-tested (owner feedback F7:
// going offline while the app is open must not leave the Poké Ball spinning).

/** What a refresh waits at most before it gives up and stops the spinner. */
export const REFRESH_CEILING_MS = 10_000
/** The quick health check before refetching: airplane mode keeps navigator.onLine true and lets requests hang. */
export const HEALTH_CHECK_MS = 3_000
/** How long the offline / "Couldn't refresh" note stays up. */
export const NOTE_MS = 1_600

export const TIMED_OUT = Symbol('timed out')

/** Resolve with `promise`, or with TIMED_OUT after `ms`. Never rejects. */
export function withTimeout(promise, ms, setTimer = setTimeout, clearTimer = clearTimeout) {
  let timer
  const ceiling = new Promise(resolve => { timer = setTimer(() => resolve(TIMED_OUT), ms) })
  return Promise.race([Promise.resolve(promise).catch(() => undefined), ceiling]).finally(() => clearTimer(timer))
}

/**
 * Is the app offline *now*, before trying anything? True when the device says so, the sync status
 * says so (two failed probes or the device event), or the last probe found the server unreachable
 * or behind a captive portal. An unknown reachability (no probe yet) is not offline.
 */
export function looksOffline({ onLine, hookOffline, reachabilityState }) {
  if (onLine === false || hookOffline) return true
  return reachabilityState === 'unreachable' || reachabilityState === 'captive'
}

/**
 * How a refresh that actually ran ended: 'ok'; 'offline' when it failed or timed out and the device
 * looks offline too; 'failed' ("Couldn't refresh") when it failed or timed out on a device that
 * looks online.
 */
export function refreshOutcome({ timedOut, anyFailed, deviceOnline }) {
  if (!timedOut && !anyFailed) return 'ok'
  return deviceOnline === false ? 'offline' : 'failed'
}

/** True when any query that is still mounted ended its last fetch in an error. */
export function activeQueriesFailed(queryClient) {
  return queryClient.getQueryCache().findAll({ type: 'active' }).some(query => query.state.status === 'error' && query.state.fetchStatus === 'idle')
}

/** Test hook: `localStorage['pc.debug.pullCeilingMs']` shortens the ceiling (like the other pc.debug flags). */
export function refreshCeilingMs(storage = globalThis.localStorage) {
  try {
    const override = Number(storage?.getItem('pc.debug.pullCeilingMs'))
    return Number.isFinite(override) && override > 0 ? override : REFRESH_CEILING_MS
  } catch {
    return REFRESH_CEILING_MS
  }
}

/**
 * Give the health check pull to refresh just ran to the shared reachability (the offline outbox's
 * monitor), so the offline banner follows it: a failed or hanging check shows the banner at once and
 * a reachable one clears it. `health` is a probe result, or TIMED_OUT. No outbox (queue off): nothing to do.
 */
export function reportHealth(outbox, health) {
  if (!outbox?.reportProbe) return
  outbox.reportProbe(health === TIMED_OUT || !health ? { state: 'unreachable' } : health)
}
