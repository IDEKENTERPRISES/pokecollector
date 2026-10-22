// Which page data is being served from the card database right now (F13b). The "not saved yet" line
// (F12) is about pages with nothing to show; a page filled from the card database has something.
import { useEffect, useSyncExternalStore } from 'react'

let count = 0
const listeners = new Set()
const emit = () => listeners.forEach(listener => listener())

export const isServingFromCardDb = () => count > 0
export const subscribeServing = listener => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Registers a mounted page query that is answered by the card database while `active`. */
export function useRegisterServing(active) {
  useEffect(() => {
    if (!active) return undefined
    count += 1
    emit()
    return () => {
      count -= 1
      emit()
    }
  }, [active])
}

export const useServingFromCardDb = () => useSyncExternalStore(subscribeServing, isServingFromCardDb, () => false)
