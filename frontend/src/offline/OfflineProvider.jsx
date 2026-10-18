import { useEffect, useMemo, useRef, useState } from 'react'
import { onlineManager, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../contexts/AuthContext'
import LogoutGuardDialog from '../components/sync/LogoutGuardDialog'
import { readPwaFlags } from '../pwa/flags'
import { getCapabilities } from './capabilities'
import { REPLAY_TICK_MS } from './constants'
import { applyDebugParams } from './debug'
import { createOutbox } from './outbox/index.js'
import { OutboxContext } from './useOutbox'

const ignore = () => {}

/**
 * Owns the outbox (docs/PWA_OFFLINE_DESIGN.md §6.2.12, P5). Inert unless the queue flag is on
 * and IndexedDB exists: then children render untouched and no logout guard is registered.
 */
export function OfflineProvider({ children }) {
  const { user, status, setLogoutGuard } = useAuth()
  const queryClient = useQueryClient()
  const enabled = useMemo(() => readPwaFlags().queue && getCapabilities().indexedDB, [])
  const [outbox, setOutbox] = useState(null)
  const [dialog, setDialog] = useState(null)
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
    const guard = async () => {
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
        // 'sync': keep the dialog open with a progress label, then look again.
        setDialog({ busy: true })
        try {
          await outbox.syncNow('logout')
        } catch {
          // items stay; the dialog comes back
        }
      }
    }
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
