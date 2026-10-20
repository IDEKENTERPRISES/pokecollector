import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'

// The nav bar's per-page options (design doc §6.5). The store is an external one so a page that
// calls useNavBar on every render updates the bar without re-rendering itself.

export function createNavBarStore() {
  let options = null
  let largeElement = null
  const listeners = new Set()
  const emit = () => listeners.forEach(listener => listener())
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getOptions: () => options,
    setOptions(next) {
      options = next
      emit()
    },
    resetOptions(owner) {
      if (options?.owner === owner) {
        options = null
        emit()
      }
    },
    getLargeElement: () => largeElement,
    setLargeElement(element) {
      if (largeElement === element) return
      largeElement = element
      emit()
    },
  }
}

export const NavBarContext = createContext(null)

export function useNavBarStore() {
  return useContext(NavBarContext)
}

/** Options registered by the current page, or null when it never called useNavBar. */
export function useNavBarOptions(store) {
  return useSyncExternalStore(store.subscribe, store.getOptions, () => null)
}

export function useLargeTitleElement(store) {
  return useSyncExternalStore(store.subscribe, store.getLargeElement, () => null)
}

/**
 * Customise the nav bar for the current page: `{ title, subtitle, largeTitle, trailing, backLabel,
 * hideBack }`. The options reset when the page unmounts. Without a call, the bar shows the
 * `navConfig` defaults (interim mode).
 */
export function useNavBar(options = {}) {
  const store = useContext(NavBarContext)
  const owner = useRef(null)
  if (owner.current === null) owner.current = Symbol('navbar')
  const registered = useMemo(() => ({ ...options, owner: owner.current }), [options])

  useEffect(() => {
    store?.setOptions(registered)
  })
  useEffect(() => () => store?.resetOptions(owner.current), [store])
}
