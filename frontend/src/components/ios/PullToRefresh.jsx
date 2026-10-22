import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CloudOff } from 'lucide-react'
import { useScanner } from '../../contexts/ScannerContext'
import { useSettings } from '../../contexts/SettingsContext'
import { PULL_THRESHOLD, usePullToRefresh } from '../../navigation/pullToRefresh'
import {
  HEALTH_CHECK_MS,
  NOTE_MS,
  TIMED_OUT,
  activeQueriesFailed,
  looksOffline,
  refreshCeilingMs,
  refreshOutcome,
  withTimeout,
} from '../../navigation/refreshOutcome'
import { probe } from '../../offline/outbox/probe'
import { useOffline } from '../../offline/useOffline'
import { useOutbox } from '../../offline/useOutbox'
import PokeBall from './PokeBall'

/**
 * Pull to refresh (design doc §14 P8, Q1b), on every page of the shell: pulling the page down from
 * the very top refetches the page's active queries. The indicator hangs under the sticky nav bar
 * (the page itself does not move, so the bar and the safe area stay put). It does nothing inside
 * sheets, menus, text fields and the scanner, or inside a container that is scrolled down.
 *
 * It never spins for ever: when the app is offline (the device says so, the sync status says so, or
 * a quick health check fails or hangs, which is how airplane mode looks on iPhone) it shows "Offline
 * mode" at once; a refresh that fails or runs past its ceiling shows "Offline mode" if the device
 * looks offline, else "Couldn't refresh".
 */
export default function PullToRefresh({ enabled }) {
  const { t } = useSettings()
  const queryClient = useQueryClient()
  const offline = useOffline()
  const { reachability } = useOutbox()
  const [note, setNote] = useState(null)
  const { isOpen: scannerOpen } = useScanner()
  const [announcement, setAnnouncement] = useState('')
  const offlineRef = useRef(offline)
  offlineRef.current = offline
  const reachabilityRef = useRef(reachability.state)
  reachabilityRef.current = reachability.state
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  // Show a note in the indicator for a moment (the spinner stops while it is up).
  const showNote = useCallback(async kind => {
    setNote(kind)
    setAnnouncement(kind === 'offline' ? t('sync.offlineShort') : t('nav.refreshFailed'))
    await new Promise(resolve => { timer.current = window.setTimeout(resolve, NOTE_MS) })
    setNote(null)
    setAnnouncement('')
  }, [t])

  const refresh = useCallback(async () => {
    const deviceOnline = globalThis.navigator?.onLine !== false
    if (looksOffline({ onLine: deviceOnline, hookOffline: offlineRef.current, reachabilityState: reachabilityRef.current })) {
      await showNote('offline')
      return
    }
    setAnnouncement(t('nav.refreshing'))
    // Airplane mode keeps navigator.onLine true and lets requests hang: ask the server first.
    const health = await withTimeout(probe({ timeoutMs: HEALTH_CHECK_MS }), HEALTH_CHECK_MS + 500)
    if (health === TIMED_OUT || health?.state !== 'reachable') {
      await showNote('offline')
      return
    }
    const result = await withTimeout(queryClient.refetchQueries({ type: 'active' }), refreshCeilingMs())
    const outcome = refreshOutcome({
      timedOut: result === TIMED_OUT,
      anyFailed: activeQueriesFailed(queryClient),
      deviceOnline: globalThis.navigator?.onLine !== false,
    })
    if (outcome === 'ok') {
      setAnnouncement(t('nav.refreshed'))
      timer.current = window.setTimeout(() => setAnnouncement(''), 1500)
    } else {
      await showNote(outcome)
    }
  }, [queryClient, showNote, t])

  const { distance, phase } = usePullToRefresh({ enabled: enabled && !scannerOpen, onRefresh: refresh })
  if (typeof document === 'undefined') return null

  const visible = phase !== 'idle'
  const progress = Math.min(1, distance / PULL_THRESHOLD)
  const visibleNote = phase === 'refreshing' ? note : null

  return createPortal(
    <>
      <div
        aria-hidden="true"
        data-testid="pull-indicator"
        data-phase={phase}
        data-note={visibleNote ?? undefined}
        className="pointer-events-none fixed inset-x-0 flex justify-center"
        style={{
          zIndex: 'calc(var(--z-navbar) - 1)',
          top: 'calc(var(--safe-top) + var(--navbar-height))',
          opacity: visible ? Math.max(0.2, progress) : 0,
          transform: `translateY(${visible ? Math.max(0, distance - 36) : -36}px)`,
          transition: phase === 'pulling' || phase === 'ready' ? 'none' : undefined,
        }}
      >
        <div
          className="flex h-9 items-center justify-center gap-1.5 rounded-full bg-card px-2.5 shadow-[0_2px_8px_rgba(0,0,0,0.5)] motion-safe:transition-[transform,opacity] motion-safe:duration-200"
          style={{ transform: phase === 'ready' ? 'scale(1.08)' : undefined }}
        >
          {visibleNote ? (
            <>
              {visibleNote === 'offline'
                ? <CloudOff size={16} className="text-yellow" />
                : <AlertCircle size={16} className="text-yellow" />}
              <span className="pr-1 text-footnote font-semibold text-text-primary">
                {visibleNote === 'offline' ? t('sync.offlineShort') : t('nav.refreshFailed')}
              </span>
            </>
          ) : (
            <span
              className={phase === 'refreshing' ? 'motion-safe:animate-spin' : undefined}
              style={phase === 'refreshing' ? undefined : { display: 'inline-flex', transform: `rotate(${distance * 4}deg)` }}
            >
              <PokeBall size={24} />
            </span>
          )}
        </div>
      </div>
      <span role="status" aria-live="polite" className="sr-only" data-testid="pull-status">{announcement}</span>
    </>,
    document.body,
  )
}
