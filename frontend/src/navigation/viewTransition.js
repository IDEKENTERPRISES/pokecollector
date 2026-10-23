// Slide transitions for push and pop (design doc §11, §14 P8, Q1c).
//
// Same-document view transitions work in Safari 18+. React Router's `viewTransition` option needs a
// data router and React's <ViewTransition> needs React 19.3, and this app uses <BrowserRouter> on
// React 18, so this is a small helper around `document.startViewTransition` + `flushSync`:
//  - feature-detected, and off under reduced motion;
//  - the navigation runs inside the transition callback, which resolves once the new location has
//    committed (Layout calls `notifyLocationCommitted`), so it works for navigate() and for the
//    asynchronous popstate of navigate(-1);
//  - the in-app Back button animates (direction 'back'); the browser's own Back and an edge swipe
//    are plain popstates and do not animate;
//  - tab switches never animate (design §7.10: "Tab switches: instant").
//
// ONE SWITCH: set SLIDE_TRANSITIONS to false to drop the whole feature after the owner tries it.

import { flushSync } from 'react-dom'

export const SLIDE_TRANSITIONS = true

const COMMIT_TIMEOUT_MS = 800
// While a view transition runs the page ignores taps. A slow phone (a busy main thread) can stretch one
// out, so after this long it is skipped and the page is live again: taps on Back or the tab bar never get lost.
const MAX_TRANSITION_MS = 1500
// The transition captures the whole page as a picture. A page many screens tall (a set of hundreds of
// cards, a long sets list) makes that picture huge, which freezes an iPhone's WebKit or kills the tab, so
// leaving such a page is instant instead.
export const MAX_PAGE_SCREENS = 4
const waiters = new Set()

export function viewTransitionsSupported(doc = globalThis.document) {
  return typeof doc?.startViewTransition === 'function'
}

export function prefersReducedMotion(win = globalThis.window) {
  return Boolean(win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)
}

export function viewTransitionsEnabled({ doc = globalThis.document, win = globalThis.window } = {}) {
  return SLIDE_TRANSITIONS && viewTransitionsSupported(doc) && !prefersReducedMotion(win)
}

export function pageTooTall(doc = globalThis.document, win = globalThis.window) {
  const height = doc?.documentElement?.scrollHeight
  const screen = win?.innerHeight
  return Number.isFinite(height) && Number.isFinite(screen) && screen > 0 && height > screen * MAX_PAGE_SCREENS
}

/** Called by Layout after each location commit; lets a waiting transition capture its new state. */
export function notifyLocationCommitted() {
  waiters.forEach(resolve => resolve())
  waiters.clear()
}

/**
 * Run `update` (a navigation) inside a slide transition. `direction` is 'push' (the new page slides
 * in from the right) or 'back' (the old page slides out to the right). Without support, or under
 * reduced motion, or with the switch off, `update` simply runs.
 */
export function runViewTransition(update, { direction = 'push', doc = globalThis.document, win = globalThis.window } = {}) {
  if (!viewTransitionsEnabled({ doc, win }) || pageTooTall(doc, win)) {
    update()
    return null
  }
  const root = doc.documentElement
  root.dataset.vt = direction
  let transition
  try {
    transition = doc.startViewTransition(() => new Promise(resolve => {
      waiters.add(resolve)
      // Whatever happens, the page must not stay frozen waiting for a commit that never comes.
      win.setTimeout(resolve, COMMIT_TIMEOUT_MS)
      flushSync(update)
    }))
  } catch {
    delete root.dataset.vt
    update()
    return null
  }
  const clear = () => { delete root.dataset.vt }
  win.setTimeout(() => { try { transition.skipTransition?.() } catch { /* already finished */ } }, MAX_TRANSITION_MS)
  transition.finished?.then(clear, clear)
  return transition
}

/** True for a plain left click that the browser would handle as an in-page navigation. */
export function isPlainClick(event) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
    && !event.defaultPrevented
}
