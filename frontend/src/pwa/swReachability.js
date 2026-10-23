// Tells the service worker whether the app is offline (the shared reachability), so the worker can
// answer a launch with the app shell and an uncached picture with an error at once, instead of
// waiting on a connection that only hangs. Also tells it when the downloaded-picture caches change.
//
// Only a change is posted, and "online" only once it has held for a few seconds.

let lastPosted = null
let pending = null
let timer = null

function controller() {
  try {
    return globalThis.navigator?.serviceWorker?.controller ?? null
  } catch {
    return null
  }
}

function post(message) {
  try {
    controller()?.postMessage(message)
  } catch {
    // No worker: nothing to tell.
  }
}

// "Back online" waits this long, so the first reachability probe after a launch has decided and a
// momentary "not offline" while the app starts never clears what the worker saved.
const ONLINE_SETTLE_MS = 4000

function flush() {
  timer = null
  const offline = pending
  pending = null
  if (offline === null || offline === lastPosted) return
  lastPosted = offline
  post({ type: 'REACHABILITY', offline })
}

/** Called with the app's reachability whenever it is set; the last value of a burst wins. */
export function reportReachability(offline) {
  pending = Boolean(offline)
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(flush, pending ? 0 : ONLINE_SETTLE_MS)
}

/** The worker should look at the picture caches again (a download added or removed one). */
export function reportPictureCachesChanged() {
  post({ type: 'PICTURE_CACHES_CHANGED' })
}

if (typeof window !== 'undefined') {
  window.addEventListener('offline', () => reportReachability(true))
  window.addEventListener('online', () => reportReachability(false))
}

export function resetReachabilityForTests() {
  lastPosted = null
  pending = null
  if (timer !== null) clearTimeout(timer)
  timer = null
}
