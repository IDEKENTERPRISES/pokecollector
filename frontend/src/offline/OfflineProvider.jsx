import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { onlineManager, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import EvictedNotice from '../components/sync/EvictedNotice'
import LogoutGuardDialog from '../components/sync/LogoutGuardDialog'
import { SavedAtContext } from '../components/sync/StaleDataLabel'
import { readPwaFlags } from '../pwa/flags'
import { getCapabilities } from './capabilities'
import { REPLAY_TICK_MS } from './constants'
import { applyDebugParams } from './debug'
import { checkCanary, initCanary, requestPersistence } from './durability'
import { openOutboxDb } from './outbox/db.js'
import { createOutbox } from './outbox/index.js'
import { cancelHungQueries, createOfflineEpisodes, refreshAfterReconnect } from './offlineEpisode'
import { setOfflineMessage, setOfflineStatus } from './offlineStatus'
import { whenLaunchSplashClosed } from '../components/splash/launch'
import { applyFirst, persist, purge, purgeOthers, readFirst, restoreMissing } from './readCache'
import { checkIn } from '../progress/checkin'
import { buildPrefetchPlan, runPrefetch } from './prefetch'
import { clearAllUserData, clearOtherUsersData } from './sessionCleanup'
import { createSyncReporter } from './syncToasts'
import { OutboxContext } from './useOutbox'

const ignore = () => {}
const RESTORE_WAIT_MS = 1500
// The rest of the saved data (the large queries) follows the first screen, once the launch splash
// is gone (or after this long), so reading it never competes with the first frames.
const RESTORE_REST_MAX_WAIT_MS = 6000
// The prefetch (F15c) waits this long after the splash closes, so the settings (price field, language) have arrived.
const PREFETCH_DELAY_MS = 2000

const RestoreGateContext = createContext(false)

/** True while a degraded (offline) start is still putting the saved data back; protected routes wait on it. */
export function useRestoreGate() {
  return useContext(RestoreGateContext)
}

/**
 * The logout guard's decision loop (D7, A6). `ask()` resolves with 'sync' | 'keep' | 'discard' |
 * 'cancel'; `setBusy(true)` shows the progress label while a sync runs; `close()` hides the dialog.
 * Resolves true when logging out may proceed. `clearCache({ kept })` (everything about the user, F15c;
 * `kept` is true when the user chose to keep unsynced changes) runs on every path that proceeds,
 * including "nothing unsynced", and never blocks the logout.
 */
export async function runLogoutGuard({ outbox, ask, setBusy, close, clearCache = ignore }) {
  const { proceed, kept } = await decideLogout({ outbox, ask, setBusy, close })
  if (proceed) {
    try {
      await clearCache({ kept })
    } catch {
      // best effort: a failed purge must not trap the user in the app
    }
  }
  return proceed
}

async function decideLogout({ outbox, ask, setBusy, close }) {
  try {
    await outbox.start()
  } catch {
    return { proceed: true, kept: false }
  }
  for (;;) {
    if (outbox.getSnapshot().items.length === 0) {
      close()
      return { proceed: true, kept: false }
    }
    const choice = await ask()
    if (choice === 'cancel') {
      close()
      return { proceed: false, kept: false }
    }
    if (choice === 'keep') {
      close()
      return { proceed: true, kept: true }
    }
    if (choice === 'discard') {
      try {
        await outbox.discardAllForUser()
      } catch {
        close()
        return { proceed: false, kept: false }
      }
      close()
      return { proceed: true, kept: false }
    }
    // 'sync': keep the dialog open with a progress label, then look again. The user asked for
    // it, so it runs as `manual` and also works when Automatic sync is switched off.
    setBusy(true)
    try {
      await outbox.syncNow('manual')
    } catch {
      // items stay; the dialog comes back
    }
  }
}

/**
 * Owns the outbox (docs/PWA_OFFLINE_DESIGN.md §6.2.12, P5). Inert unless the queue flag is on
 * and IndexedDB exists: then children render untouched and no logout guard is registered.
 */
export function OfflineProvider({ children }) {
  const { user, status, setLogoutGuard, multiUser } = useAuth()
  const queryClient = useQueryClient()
  const { t, pricePrimaryField, settings } = useSettings()
  const tRef = useRef(t)
  tRef.current = t
  const prefetchInputRef = useRef({})
  prefetchInputRef.current = { pricePrimaryField, language: settings?.language, multiUser }
  const enabled = useMemo(() => readPwaFlags().queue && getCapabilities().indexedDB, [])
  const [outbox, setOutbox] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [evicted, setEvicted] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [restoreDone, setRestoreDone] = useState(false)
  const resolveRef = useRef(null)
  const persisterRef = useRef(null)
  const restoreStartedRef = useRef(false)
  const firstReadRef = useRef(null)
  const userIdRef = useRef(null)
  userIdRef.current = typeof user?.id === 'number' ? user.id : null

  const userId = userIdRef.current
  const active = (status === 'ready' || status === 'degraded') && userId !== null

  useEffect(() => {
    if (enabled) applyDebugParams()
  }, [enabled])

  useEffect(() => {
    if (!enabled) return undefined
    const instance = createOutbox({
      ctx: () => (userIdRef.current === null ? null : { userId: userIdRef.current, origin: window.location.origin }),
      flags: { queue: true },
      queryClient,
      onlineManager,
    })
    // Every replay result, whoever started it (ticks, the sheet, the logout guard), feeds the toasts.
    const report = createSyncReporter({ toast, getT: () => tRef.current })
    const rawSyncNow = instance.syncNow
    instance.syncNow = async (...args) => {
      const result = await rawSyncNow(...args)
      report(result)
      return result
    }
    setOutbox(instance)
    return () => {
      instance.stop()
      setOutbox(null)
    }
  }, [enabled, queryClient])

  // Start once a user is known; sync when the signed-in user changes (A4).
  useEffect(() => {
    if (!outbox || !active) return
    outbox.start().then(() => {
      // The startup auth check gave up: no need to wait for two probes to show the banner.
      if (status === 'degraded') outbox.noteUnreachable()
      return outbox.syncNow('login')
    }).catch(ignore)
  }, [outbox, active, userId, status])

  // Daily check-in (engagement P1): on start and each return to the foreground; silent, never awaited.
  useEffect(() => {
    if (!active) return undefined
    const run = () => { if (document.visibilityState === 'visible') checkIn(userId) }
    run()
    document.addEventListener('visibilitychange', run)
    return () => document.removeEventListener('visibilitychange', run)
  }, [active, userId])

  // Read cache (P8): other users' saved data goes as soon as the signed-in user is known.
  // A different user signing in also clears the previous user's queued items and viewed pictures (F15c).
  useEffect(() => {
    if (!enabled || userId === null) return
    purgeOthers({ origin: window.location.origin, keepUserId: userId })
      .then(removed => clearOtherUsersData({ keepUserId: userId, readCacheRemoved: removed }))
      .catch(ignore)
  }, [enabled, userId])

  // Prefetch (F15c): once the launch splash has closed, every page's data of the signed-in user is fetched
  // in the background (two at a time, never while offline) so the read cache saves it for pages never opened.
  const outboxRef = useRef(null)
  const signingOutRef = useRef(false)
  outboxRef.current = outbox
  useEffect(() => {
    if (!enabled || status !== 'ready' || userId === null) return undefined
    let cancelled = false
    let running = false
    let timer = null
    const isOnline = () => (
      onlineManager.isOnline()
      && globalThis.navigator?.onLine !== false
      && !outboxRef.current?.getSnapshot().reachability.bannerVisible
    )
    const run = async () => {
      if (running || cancelled || !isOnline()) return
      running = true
      try {
        const plan = buildPrefetchPlan({ ...prefetchInputRef.current, userId })
        await runPrefetch(queryClient, plan, { isOnline, shouldStop: () => cancelled || signingOutRef.current })
      } catch {
        // background work: a failure is just a page that was not saved ahead
      } finally {
        running = false
      }
    }
    whenLaunchSplashClosed().then(() => {
      if (!cancelled) timer = window.setTimeout(run, PREFETCH_DELAY_MS)
    })
    // Back online after an offline start: fetch what was missed.
    const onOnline = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(run, PREFETCH_DELAY_MS)
    }
    window.addEventListener('online', onOnline)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.removeEventListener('online', onOnline)
    }
  }, [enabled, status, userId, queryClient])

  // Cold start (F14c): the small saved queries are read while the sign-in check is still waiting, so
  // a degraded start only has to put them back. Only reads here; nothing is hydrated unless degraded.
  useEffect(() => {
    if (!enabled || userId === null || firstReadRef.current) return
    firstReadRef.current = readFirst({ origin: window.location.origin, userId })
  }, [enabled, userId])

  // A degraded start puts the first screen's saved data back before protected routes mount (or after
  // 1.5 s); the large queries follow once the launch splash has closed.
  useEffect(() => {
    if (!enabled || status !== 'degraded' || userId === null || restoreStartedRef.current) return undefined
    restoreStartedRef.current = true
    let cancelled = false
    const timer = window.setTimeout(() => setRestoreDone(true), RESTORE_WAIT_MS)
    const origin = window.location.origin
    const first = firstReadRef.current || readFirst({ origin, userId })
    first
      .then(result => {
        const { savedAt: saved, complete } = applyFirst(queryClient, result)
        if (saved) setSavedAt(saved)
        return complete
      })
      .catch(() => true)
      .then(complete => {
        window.clearTimeout(timer)
        setRestoreDone(true)
        if (complete) return undefined
        return whenLaunchSplashClosed(RESTORE_REST_MAX_WAIT_MS).then(() => (
          cancelled ? null : restoreMissing(queryClient, { origin, userId })
        ))
      })
      .then(rest => { if (rest?.restored > 0) setSavedAt(rest.savedAt) })
      .catch(ignore)
    return () => { cancelled = true }
  }, [enabled, status, userId, queryClient])

  // Going offline while the app is open (owner feedback F11): once per offline episode the saved read
  // cache is merged back (never over data this session already holds), the label shows, and fetches
  // that can only hang (in flight, nothing to show) are cancelled, so a page opened now shows the saved
  // data, or its normal empty state, instead of spinning. Back online, mounted queries refetch and the
  // label goes. A degraded start restores on its own (above); this covers a session that started online.
  useEffect(() => {
    if (!outbox || !active) return undefined
    const episodes = createOfflineEpisodes()
    let cancelled = false
    const onChange = async () => {
      const bannerVisible = outbox.getSnapshot().reachability.bannerVisible
      // The API client refuses changes at once while the app is offline (no spinner, no silent failure).
      setOfflineMessage(tRef.current('sync.actionNeedsConnection'))
      setOfflineStatus(bannerVisible)
      const event = episodes.update(bannerVisible)
      if (event === 'start') {
        const { savedAt: saved, restored } = await restoreMissing(queryClient, { origin: window.location.origin, userId })
        if (cancelled || !episodes.isOffline()) return
        if (restored > 0) setSavedAt(saved)
        cancelHungQueries(queryClient)
      } else if (event === 'end') {
        setSavedAt(null)
        refreshAfterReconnect(queryClient)
      }
    }
    const unsubscribe = outbox.subscribe(onChange)
    onChange()
    return () => {
      cancelled = true
      unsubscribe()
      setOfflineStatus(false)
    }
  }, [outbox, active, userId, queryClient])

  // The server answered again: the pages hold fresh data, so the "saved data" label goes.
  useEffect(() => {
    if (status !== 'ready') return
    setSavedAt(null)
    setRestoreDone(true) // a session that started online never waits for a restore
  }, [status])

  // Saves allow-listed query results while a user is signed in. It starts after a degraded
  // start's restore so a half-empty cache never replaces the saved record.
  const persistReady = status === 'ready' || restoreDone
  useEffect(() => {
    if (!enabled || !active || !persistReady) return undefined
    const persister = persist(queryClient, { origin: window.location.origin, userId })
    persisterRef.current = persister
    return () => {
      persister.stop()
      if (persisterRef.current === persister) persisterRef.current = null
    }
  }, [enabled, active, persistReady, userId, queryClient])

  // Storage protection (D12): persist() after the first enqueue and on every start while items
  // wait, and notice when the browser removed the database behind our back.
  useEffect(() => {
    if (!outbox || !active) return undefined
    let cancelled = false
    let requested = false
    const protect = async () => {
      if (requested || outbox.getSnapshot().items.length === 0) return
      requested = true
      let db = null
      try {
        db = await openOutboxDb()
        await requestPersistence({ db })
      } catch {
        // best effort
      } finally {
        db?.close()
      }
    }
    const checkEviction = async () => {
      let db = null
      try {
        await outbox.start()
        db = await openOutboxDb()
        const result = await checkCanary(db)
        if (result === 'evicted' && !cancelled) setEvicted(true)
        if (result !== 'ok') await initCanary(db)
      } catch {
        // the canary is advisory
      } finally {
        db?.close()
      }
      if (!cancelled) protect()
    }
    checkEviction()
    const unsubscribe = outbox.subscribe(() => { if (!cancelled) protect() })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [outbox, active])

  useEffect(() => {
    if (!outbox || !active) return undefined
    const sync = () => {
      if (document.visibilityState === 'visible') outbox.syncNow('auto').catch(ignore)
    }
    document.addEventListener('visibilitychange', sync)
    window.addEventListener('online', sync)
    window.addEventListener('pageshow', sync)
    const timer = window.setInterval(sync, REPLAY_TICK_MS)
    return () => {
      document.removeEventListener('visibilitychange', sync)
      window.removeEventListener('online', sync)
      window.removeEventListener('pageshow', sync)
      window.clearInterval(timer)
    }
  }, [outbox, active])

  // Logout guard (D7, A6): the dialog decides what happens to unsynced items.
  useEffect(() => {
    if (!outbox) return undefined
    const ask = () => new Promise(resolve => {
      resolveRef.current = resolve
      setDialog({ busy: false })
    })
    const close = () => {
      resolveRef.current = null
      setDialog(null)
    }
    // Stop the writer first so a pending save cannot bring the data back after the purge.
    // Then everything about the user goes, bar the card database (F15c); AuthContext reloads the page.
    const clearCache = async ({ kept = false } = {}) => {
      if (userIdRef.current === null) return
      signingOutRef.current = true
      await persisterRef.current?.stop()
      await purge({ origin: window.location.origin, userId: userIdRef.current })
      queryClient.cancelQueries()
      if (!kept) outbox.stop() // closes its database so it can be deleted
      await clearAllUserData({ keepOutbox: kept })
    }
    const guard = () => runLogoutGuard({ outbox, ask, setBusy: busy => setDialog({ busy }), close, clearCache })
    setLogoutGuard(guard)
    return () => {
      setLogoutGuard(null)
      resolveRef.current?.('cancel')
      resolveRef.current = null
      setDialog(null)
    }
  }, [outbox, setLogoutGuard])

  if (!enabled) return children

  const choose = choice => resolveRef.current?.(choice)
  // Only the protected routes wait (App's ProtectedRoutes asks useRestoreGate); the rest of the tree,
  // the launch splash included, stays mounted, so a restore never blanks the screen.
  const gated = status === 'degraded' && userId !== null && !restoreDone

  return (
    <OutboxContext.Provider value={outbox}>
      <SavedAtContext.Provider value={savedAt}>
        <RestoreGateContext.Provider value={gated}>
          {children}
        </RestoreGateContext.Provider>
      </SavedAtContext.Provider>
      <EvictedNotice isOpen={evicted} onClose={() => setEvicted(false)} />
      <LogoutGuardDialog
        isOpen={Boolean(dialog)}
        busy={Boolean(dialog?.busy)}
        onSync={() => choose('sync')}
        onKeep={() => choose('keep')}
        onDiscard={() => choose('discard')}
        onCancel={() => choose('cancel')}
      />
    </OutboxContext.Provider>
  )
}

export default OfflineProvider
