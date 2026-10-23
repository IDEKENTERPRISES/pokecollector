import { useEffect, useSyncExternalStore } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { whenLaunchSplashClosed } from '../../components/splash/launch'
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
  prefs: { enabled: false, languages: {}, pictures: {} }, picturesMigrated: [], picturesNeedRedownload: false,
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
 * It does not exist at all until the server has answered the sign-in check (a start without the
 * server, the iPhone's offline start included, never touches the card database or sends the
 * manifest request that would only hang), and then waits for the first screen and the splash.
 */
export function CardDbAutoSync() {
  const { user, status } = useAuth()
  const ready = Boolean(user) && status === 'ready'
  useEffect(() => {
    if (!ready) return undefined
    const instance = getCardDbController()
    if (!instance) return undefined
    const run = () => {
      instance.sync().catch(() => {})
    }
    // Let the first screen render and its own queries go first.
    const timer = window.setTimeout(() => {
      whenLaunchSplashClosed(3000).then(run)
    }, 3000)
    // The old picture caches (pre-F16a) are removed well after the first screen, in the background.
    const migrateTimer = window.setTimeout(() => {
      instance.migrateLegacyPictures().catch(() => {})
    }, 8000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') run()
    }
    window.addEventListener('online', run)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(migrateTimer)
      window.removeEventListener('online', run)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [ready])
  return null
}
