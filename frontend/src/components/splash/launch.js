// When the launch splash shows: pure helpers, plus one decision remembered for the document.
// Kept free of React and of the splash's art, because pwa/register.js imports it too.
import { REDUCED_MOTION, SHOW_IN } from './config'

export const ENABLED_KEY = 'pc.splash.enabled' // localStorage, per device: '0' turns it off
export const SUPPRESS_KEY = 'pc.splash.suppressOnce' // sessionStorage, set before an automatic reload
export const E2E_KEY = 'pc.splash.e2e' // localStorage: lets an automated browser see the splash

function attempt(read, fallback = null) {
  try {
    return read()
  } catch {
    return fallback
  }
}

export function readSplashEnabled(storage = globalThis.localStorage) {
  return attempt(() => storage?.getItem(ENABLED_KEY)) !== '0'
}

export function writeSplashEnabled(enabled, storage = globalThis.localStorage) {
  attempt(() => storage?.setItem(ENABLED_KEY, enabled ? '1' : '0'))
}

/** Called right before the service worker's update reload (and the stale-chunk reload), so the
 * app comes back without the splash. */
export function suppressNextSplash(storage = globalThis.sessionStorage) {
  attempt(() => storage?.setItem(SUPPRESS_KEY, '1'))
}

/** True once after suppressNextSplash(); the flag is removed as it is read. */
export function consumeSplashSuppression(storage = globalThis.sessionStorage) {
  return attempt(() => {
    if (storage?.getItem(SUPPRESS_KEY) !== '1') return false
    storage.removeItem(SUPPRESS_KEY)
    return true
  }, false)
}

/** Public pages and invite links have their own audience; /__ pages are DEV galleries. */
export function isSplashPath(pathname = '/') {
  return !/^\/(u|invite)(\/|$)/.test(pathname) && !pathname.startsWith('/__')
}

/** 'full', 'still' (Reduce Motion) or null (no splash). Pure. */
export function splashMode({
  pathname = '/',
  enabled = true,
  suppressed = false,
  automated = false,
  optedIn = false,
  standalone = false,
  reducedMotion = false,
  showIn = SHOW_IN,
  reducedMotionMode = REDUCED_MOTION,
} = {}) {
  if (!enabled || suppressed || !isSplashPath(pathname)) return null
  // Automated browsers (navigator.webdriver) skip it unless a test opts in, so the existing
  // end-to-end and visual suites see the app exactly as before.
  if (automated && !optedIn) return null
  if (showIn === 'standalone' && !standalone) return null
  if (reducedMotion) return reducedMotionMode === 'off' ? null : 'still'
  return 'full'
}

function matches(query) {
  return attempt(() => globalThis.matchMedia?.(query).matches, false) === true
}

export function browserLaunchEnv() {
  return {
    pathname: globalThis.location?.pathname || '/',
    enabled: readSplashEnabled(),
    // Always consumed, even when the splash is off for another reason, so it never lingers.
    suppressed: consumeSplashSuppression(),
    automated: globalThis.navigator?.webdriver === true,
    optedIn: attempt(() => globalThis.localStorage?.getItem(E2E_KEY)) === '1',
    standalone: matches('(display-mode: standalone)') || globalThis.navigator?.standalone === true,
    reducedMotion: matches('(prefers-reduced-motion: reduce)'),
  }
}

// A fresh launch is the first render of a new document: a cold start or a reload. The decision
// is taken once and remembered, so in-app navigation, a remount or StrictMode's double render
// never brings the splash back, and neither does anything after it has closed.
let decided = false
let mode = null
let closed = false
const closeWaiters = new Set()

export function launchSplashMode(env = browserLaunchEnv) {
  if (!decided) {
    decided = true
    mode = splashMode(typeof env === 'function' ? env() : env)
  }
  return closed ? null : mode
}

export function markLaunchSplashClosed() {
  closed = true
  for (const resolve of closeWaiters) resolve()
  closeWaiters.clear()
}

/** Resolves once the launch splash has closed (or at once when this launch has none), at the latest after `maxMs`.
 * For work that should not compete with the splash's first frames. */
export function whenLaunchSplashClosed(maxMs = 6000) {
  if (closed || !launchSplashMode()) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => {
      window.clearTimeout(timer)
      closeWaiters.delete(done)
      resolve()
    }
    const timer = window.setTimeout(done, maxMs)
    closeWaiters.add(done)
  })
}

export function resetLaunchForTests() {
  decided = false
  mode = null
  closed = false
  closeWaiters.clear()
}
