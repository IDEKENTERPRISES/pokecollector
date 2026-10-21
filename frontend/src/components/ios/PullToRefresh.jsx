import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { CloudOff } from 'lucide-react'
import { useScanner } from '../../contexts/ScannerContext'
import { useSettings } from '../../contexts/SettingsContext'
import { PULL_THRESHOLD, usePullToRefresh } from '../../navigation/pullToRefresh'
import { useOffline } from '../../offline/useOffline'
import PokeBall from './PokeBall'

const OFFLINE_NOTE_MS = 1400

/**
 * Pull to refresh for a tab root (design doc §14 P8, Q1b): pulling the page down from the very top
 * refetches the page's active queries. The indicator hangs under the sticky nav bar (the page itself
 * does not move, so the bar and the safe area stay put). It does nothing inside sheets and menus.
 * Offline, a pull shows the existing offline status instead of spinning.
 */
export default function PullToRefresh({ enabled }) {
  const { t } = useSettings()
  const queryClient = useQueryClient()
  const offline = useOffline()
  const { isOpen: scannerOpen } = useScanner()
  const [announcement, setAnnouncement] = useState('')
  const offlineRef = useRef(offline)
  offlineRef.current = offline
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const refresh = useCallback(async () => {
    if (offlineRef.current) {
      // Nothing can be fetched: show the offline status for a moment instead.
      setAnnouncement(t('sync.offlineShort'))
      await new Promise(resolve => { timer.current = window.setTimeout(resolve, OFFLINE_NOTE_MS) })
      setAnnouncement('')
      return
    }
    setAnnouncement(t('nav.refreshing'))
    await queryClient.refetchQueries({ type: 'active' })
    setAnnouncement(t('nav.refreshed'))
    timer.current = window.setTimeout(() => setAnnouncement(''), 1500)
  }, [queryClient, t])

  const { distance, phase } = usePullToRefresh({ enabled: enabled && !scannerOpen, onRefresh: refresh })
  if (typeof document === 'undefined') return null

  const visible = phase !== 'idle'
  const progress = Math.min(1, distance / PULL_THRESHOLD)
  const showOffline = phase === 'refreshing' && offline

  return createPortal(
    <>
      <div
        aria-hidden="true"
        data-testid="pull-indicator"
        data-phase={phase}
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
          {showOffline ? (
            <>
              <CloudOff size={16} className="text-yellow" />
              <span className="pr-1 text-footnote font-semibold text-text-primary">{t('sync.offlineShort')}</span>
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
