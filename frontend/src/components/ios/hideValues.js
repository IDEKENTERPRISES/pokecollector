import { useSyncExternalStore } from 'react'

// "Hide values" (design doc Q1a, Q16): every amount in the app shows as •••• while it is on.
// The state is one small store shared by every consumer, persisted in localStorage.

export const HIDE_VALUES_KEY = 'pc.hideValues'
export const HIDDEN_VALUE = '••••'

const listeners = new Set()
let cached = null

function readStored() {
  try {
    return globalThis.localStorage?.getItem(HIDE_VALUES_KEY) === '1'
  } catch {
    return false
  }
}

export function getHideValues() {
  if (cached === null) cached = readStored()
  return cached
}

export function setHideValues(next) {
  const value = Boolean(next)
  cached = value
  try {
    if (value) globalThis.localStorage?.setItem(HIDE_VALUES_KEY, '1')
    else globalThis.localStorage?.removeItem(HIDE_VALUES_KEY)
  } catch {
    // Private mode or blocked storage: the choice still holds for this session.
  }
  listeners.forEach(listener => listener())
}

export function subscribeHideValues(listener) {
  listeners.add(listener)
  const onStorage = event => {
    if (event.key === HIDE_VALUES_KEY || event.key === null) {
      cached = readStored()
      listener()
    }
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

/** Test helper: forget the cached value so the next read goes to localStorage again. */
export function resetHideValuesCache() {
  cached = null
}

/** Mask a formatted amount while values are hidden. A missing amount ("-") has nothing to hide. */
export function maskValue(formatted, hidden) {
  if (!hidden) return formatted
  return formatted === '-' ? formatted : HIDDEN_VALUE
}

/** `{ hidden, setHidden, toggle }`, shared across the whole app. */
export function useHideValues() {
  const hidden = useSyncExternalStore(subscribeHideValues, getHideValues, () => false)
  return { hidden, setHidden: setHideValues, toggle: () => setHideValues(!getHideValues()) }
}
