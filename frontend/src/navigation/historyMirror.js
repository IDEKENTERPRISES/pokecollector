// A mirror of the in-app history (design doc §6.4). `navigate(-1)` alone is wrong after a tab
// switch: Collection › binder, switch to Search, back to Collection (the binder again), then back
// would land on Search. The mirror knows which entry is behind the current one.

import { sectionForPath } from './navConfig.js'

export const HISTORY_KEY = 'pc.nav.history.v1'
export const MAX_ENTRIES = 50

export const emptyHistory = Object.freeze({ entries: Object.freeze([]), index: -1 })

function makeEntry({ key, path, section }) {
  return { key, path, section: section ?? sectionForPath(String(path).split('?')[0]) }
}

function capped(entries, index) {
  const overflow = entries.length - MAX_ENTRIES
  if (overflow <= 0) return { entries, index }
  return { entries: entries.slice(overflow), index: Math.max(0, index - overflow) }
}

/**
 * Actions mirror React Router's navigation types:
 *  PUSH    drop the entries after the current index, append the new one;
 *  REPLACE overwrite the current entry;
 *  POP     move to the entry with that key; an unknown key (after a reload) resets to the current location.
 */
export function historyReducer(state, action) {
  const entry = makeEntry(action)
  if (action.type === 'PUSH') {
    const entries = [...state.entries.slice(0, state.index + 1), entry]
    return capped(entries, entries.length - 1)
  }
  if (action.type === 'REPLACE') {
    if (state.index < 0) return { entries: [entry], index: 0 }
    const entries = state.entries.slice()
    entries[state.index] = entry
    return { entries, index: state.index }
  }
  if (action.type === 'POP') {
    const found = state.entries.findIndex(item => item.key === action.key)
    if (found >= 0) {
      const entries = state.entries.slice()
      entries[found] = { ...entries[found], path: entry.path, section: entry.section }
      return { entries, index: found }
    }
    return { entries: [entry], index: 0 }
  }
  return state
}

export function previousEntry(state) {
  return state.index > 0 ? state.entries[state.index - 1] ?? null : null
}

export function currentEntry(state) {
  return state.index >= 0 ? state.entries[state.index] ?? null : null
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
    const parsed = JSON.parse(sessionStore()?.getItem(HISTORY_KEY))
    if (!parsed || !Array.isArray(parsed.entries) || !Number.isInteger(parsed.index)) return emptyHistory
    const entries = parsed.entries.filter(item => item && typeof item.key === 'string' && typeof item.path === 'string')
    if (entries.length !== parsed.entries.length) return emptyHistory
    return { entries, index: Math.min(parsed.index, entries.length - 1) }
  } catch {
    return emptyHistory
  }
}

let state = emptyHistory
let loaded = false

export function getHistory() {
  if (!loaded) {
    loaded = true
    state = readStored()
  }
  return state
}

/** Apply one navigation to the shared mirror and persist it. Called by Layout on every location change. */
export function recordNavigation(action) {
  state = historyReducer(getHistory(), action)
  try {
    sessionStore()?.setItem(HISTORY_KEY, JSON.stringify(state))
  } catch {
    // Private mode: the mirror still works for this page load.
  }
  return state
}

/** Test helper: forget the shared state. */
export function resetHistoryMirror() {
  state = emptyHistory
  loaded = true
  try {
    sessionStore()?.removeItem(HISTORY_KEY)
  } catch {
    // ignore
  }
}
