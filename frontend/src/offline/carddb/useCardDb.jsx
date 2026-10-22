import { useEffect, useSyncExternalStore } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { createCardDbController, createFetchJson } from './controller.js'
import { createCardDbStore } from './store.js'

let controller = null

/** The one controller of this tab (created on first use; null without IndexedDB support). */
export function getCardDbController() {
  if (!controller && typeof indexedDB !== 'undefined') {
    controller = createCardDbController({ store: createCardDbStore(), fetchJson: createFetchJson() })
    controller.hydrate()
  }
  return controller
}

const NOOP_SNAPSHOT = Object.freeze({
  serverEnabled: false, available: [], status: 'idle', progress: null, languages: {}, storageOk: false, error: null,
  prefs: { enabled: false, languages: {}, pictures: {} },
})
const noopSubscribe = () => () => {}

/** `{ ...snapshot, actions }` for the Settings card and the offline pages. */
export function useCardDb() {
  const instance = getCardDbController()
  const snapshot = useSyncExternalStore(instance ? instance.subscribe : noopSubscribe, instance ? instance.getSnapshot : () => NOOP_SNAPSHOT)
  return { ...snapshot, actions: instance, supported: Boolean(instance) }
}

/**
 * Starts a sync when the app opens (signed in) and again when the connection comes back or the
 * app returns to the foreground. It never blocks anything and is throttled by the controller.
 */
export function CardDbAutoSync() {
  const { user } = useAuth()
  const signedIn = Boolean(user)
  useEffect(() => {
    if (!signedIn) return undefined
    const instance = getCardDbController()
    if (!instance) return undefined
    const run = () => {
      instance.sync().catch(() => {})
    }
    // Let the first screen render and its own queries go first.
    const timer = window.setTimeout(run, 3000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') run()
    }
    window.addEventListener('online', run)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('online', run)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [signedIn])
  return null
}
