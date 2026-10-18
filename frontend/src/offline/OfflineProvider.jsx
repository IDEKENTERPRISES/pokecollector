import { useEffect, useMemo, useRef, useState } from 'react'
import { onlineManager, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import EvictedNotice from '../components/sync/EvictedNotice'
import LogoutGuardDialog from '../components/sync/LogoutGuardDialog'
import { readPwaFlags } from '../pwa/flags'
import { getCapabilities } from './capabilities'
import { REPLAY_TICK_MS } from './constants'
import { applyDebugParams } from './debug'
import { checkCanary, initCanary, requestPersistence } from './durability'
import { openOutboxDb } from './outbox/db.js'
import { createOutbox } from './outbox/index.js'
import { createSyncReporter } from './syncToasts'
import { OutboxContext } from './useOutbox'

const ignore = () => {}

/**
 * The logout guard's decision loop (D7, A6). `ask()` resolves with 'sync' | 'keep' | 'discard' |
 * 'cancel'; `setBusy(true)` shows the progress label while a sync runs; `close()` hides the dialog.
 * Resolves true when logging out may proceed.
 */
export async function runLogoutGuard({ outbox, ask, setBusy, close }) {
  try {
    await outbox.start()
  } catch {
    return true
  }
  for (;;) {
    if (outbox.getSnapshot().items.length === 0) {
      close()
      return true
    }
    const choice = await ask()
    if (choice === 'cancel') {
      close()
      return false
    }
    if (choice === 'keep') {
      close()
      return true
    }
    if (choice === 'discard') {
      try {
        await outbox.discardAllForUser()
      } catch {
        close()
        return false
      }
      close()
      return true
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
  const { user, status, setLogoutGuard } = useAuth()
  const queryClient = useQueryClient()
  const { t } = useSettings()
  const tRef = useRef(t)
  tRef.current = t
  const enabled = useMemo(() => readPwaFlags().queue && getCapabilities().indexedDB, [])
  const [outbox, setOutbox] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [evicted, setEvicted] = useState(false)
  const resolveRef = useRef(null)
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
    outbox.start().then(() => outbox.syncNow('login')).catch(ignore)
  }, [outbox, active, userId])

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
    const guard = () => runLogoutGuard({ outbox, ask, setBusy: busy => setDialog({ busy }), close })
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

  return (
    <OutboxContext.Provider value={outbox}>
      {children}
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
