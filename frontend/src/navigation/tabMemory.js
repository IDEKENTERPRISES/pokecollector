// Tab memory and re-tap (design doc §6.3). The last location of each tab is remembered in memory
// and in sessionStorage so switching tabs returns to where you were, and tapping the active tab
// walks back to its root, then to the top of the page.

import { TABS, isRootPath, tabForPath } from './navConfig.js'

export const TABS_KEY = 'pc.tabs.v1'

const tabKeys = TABS.map(tab => tab.key)

export const emptyTabMemory = Object.freeze({
  last: Object.freeze({}),
  lastRoot: Object.freeze({}),
})

/** VISIT: remember `pathname + search` as the tab's last location, and its root when this is one. */
export function tabMemoryReducer(state, action) {
  if (action.type !== 'VISIT') return state
  const tab = tabForPath(action.pathname)
  if (!tab) return state
  const next = {
    last: { ...state.last, [tab]: `${action.pathname}${action.search ?? ''}` },
    lastRoot: state.lastRoot,
  }
  if (isRootPath(action.pathname)) next.lastRoot = { ...state.lastRoot, [tab]: action.pathname }
  return next
}

/**
 * What tapping `tabKey` does while at `currentPathname`:
 *  - another tab is active: go to the tab's last location, else its root;
 *  - the tab is active on a pushed page: go to the tab's last root (Collection's root is whichever
 *    segment was open last);
 *  - the tab is active at its root: scroll to the top.
 */
export function resolveTabPress(state, tabKey, currentPathname) {
  const tab = TABS.find(item => item.key === tabKey)
  if (!tab) return { type: 'none' }
  const activeTab = tabForPath(currentPathname)
  if (activeTab !== tabKey) return { type: 'navigate', to: state.last[tabKey] ?? tab.root }
  if (isRootPath(currentPathname)) return { type: 'scrollTop' }
  return { type: 'navigate', to: state.lastRoot[tabKey] ?? tab.root }
}

function sessionStore() {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

function readStored() {
  try {
    const parsed = JSON.parse(sessionStore()?.getItem(TABS_KEY))
    const clean = value => Object.fromEntries(
      Object.entries(value && typeof value === 'object' ? value : {})
        .filter(([key, path]) => tabKeys.includes(key) && typeof path === 'string' && path.startsWith('/')),
    )
    return { last: clean(parsed?.last), lastRoot: clean(parsed?.lastRoot) }
  } catch {
    return emptyTabMemory
  }
}

let state = null

export function getTabMemory() {
  if (!state) state = readStored()
  return state
}

export function visitLocation({ pathname, search }) {
  state = tabMemoryReducer(getTabMemory(), { type: 'VISIT', pathname, search })
  try {
    sessionStore()?.setItem(TABS_KEY, JSON.stringify(state))
  } catch {
    // Private mode: memory still works for this page load.
  }
}

/** Test helper. */
export function resetTabMemory() {
  state = null
  try {
    sessionStore()?.removeItem(TABS_KEY)
  } catch {
    // ignore
  }
}

// Scroll offsets are saved per location when leaving a tab and restored once the page has content.
const scrollOffsets = new Map()
let pendingRestore = null

export function locationId({ pathname, search }) {
  return `${pathname}${search ?? ''}`
}

export function saveScroll(id, top = window.scrollY) {
  scrollOffsets.set(id, Math.max(0, Math.round(top)))
}

/** Ask for `target` ("/path?search") to be scrolled back to its saved offset after it renders. */
export function requestScrollRestore(target) {
  pendingRestore = scrollOffsets.has(target) ? target : null
}

/** Called after each location change; retries for up to one second while the content loads. */
export function restorePendingScroll(currentId, win = window) {
  const wanted = pendingRestore
  pendingRestore = null
  if (!wanted || wanted !== currentId) return () => {}
  const top = scrollOffsets.get(wanted) ?? 0
  if (top <= 0) return () => {}
  const started = Date.now()
  let frame = 0
  const attempt = () => {
    win.scrollTo({ top, left: 0, behavior: 'auto' })
    if (Math.abs(win.scrollY - top) > 2 && Date.now() - started < 1000) frame = win.requestAnimationFrame(attempt)
  }
  frame = win.requestAnimationFrame(attempt)
  return () => win.cancelAnimationFrame(frame)
}

export function resetScrollMemory() {
  scrollOffsets.clear()
  pendingRestore = null
}
