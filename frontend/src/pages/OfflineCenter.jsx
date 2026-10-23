import { useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { Check, X } from 'lucide-react'
import InstallHint from '../components/pwa/InstallHint'
import OfflineCardDbSection from '../components/settings/OfflineCardDbSection'
import { StorageSummary, SyncControls, SyncItemList } from '../components/sync/SyncSheet'
import { useSettings } from '../contexts/SettingsContext'
import { getCapabilities } from '../offline/capabilities'
import { getCardDbController } from '../offline/carddb/useCardDb'
import { offlineCenterGate } from '../offline/centerGate'
import { probe } from '../offline/outbox/probe'
import { purgeAll } from '../offline/readCache'
import { useOutbox } from '../offline/useOutbox'
import { readPwaFlags } from '../pwa/flags'
import { resetServiceWorker } from '../pwa/register'
import { useNavBar } from '../navigation/useNavBar'

function appVersion() {
  // eslint-disable-next-line no-undef
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
}

// Asks the active worker for its build id; null without a controller or after 1.5 s.
function readBuildId() {
  return new Promise(resolve => {
    const controller = globalThis.navigator?.serviceWorker?.controller
    if (!controller) {
      resolve(null)
      return
    }
    const timer = window.setTimeout(() => resolve(null), 1500)
    const onMessage = event => {
      if (event.data?.type !== 'VERSION') return
      window.clearTimeout(timer)
      navigator.serviceWorker.removeEventListener('message', onMessage)
      resolve(event.data.buildId || null)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    controller.postMessage({ type: 'GET_VERSION' })
  })
}

function Section({ title, children }) {
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      {children}
    </section>
  )
}

function Capability({ label, ok }) {
  const { t } = useSettings()
  return (
    <li className="flex items-center justify-between gap-3 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className={`inline-flex items-center gap-1 text-xs font-medium ${ok ? 'text-green' : 'text-text-muted'}`}>
        {ok ? <Check size={13} aria-hidden /> : <X size={13} aria-hidden />}
        {ok ? t('pwa.supported') : t('pwa.unsupported')}
      </span>
    </li>
  )
}

const NAV_BAR = {}

export default function OfflineCenter() {
  const { t } = useSettings()
  useNavBar(NAV_BAR)
  const { enabled, outbox, reachability } = useOutbox()
  const [unavailable, setUnavailable] = useState(false)
  const [live, setLive] = useState(null)
  const [buildId, setBuildId] = useState(null)
  const capabilities = getCapabilities()

  const check = useCallback(() => probe().then(setLive), [])

  useEffect(() => {
    if (!outbox) return
    outbox.start().catch(() => setUnavailable(true))
  }, [outbox])

  useEffect(() => {
    if (!enabled) return undefined
    check()
    window.addEventListener('online', check)
    return () => window.removeEventListener('online', check)
  }, [enabled, check])

  useEffect(() => { readBuildId().then(setBuildId) }, [])

  // Redirect only when the queue is really off; the outbox appears a moment after the first render.
  const gate = offlineCenterGate({ queueFlag: readPwaFlags().queue, indexedDB: capabilities.indexedDB, enabled })
  if (gate === 'redirect') return <Navigate to="/" replace />
  if (gate === 'wait') return <div role="status" aria-label={t('ios.loading')} data-testid="offline-center-loading" className="min-h-[40vh]" />

  const state = live?.state || reachability.state
  const stateText = state === 'reachable' ? t('pwa.reachable') : state === 'captive' ? t('pwa.captive') : state === 'unknown' ? '…' : t('pwa.unreachable')
  const info = live?.serverInfo

  const reset = async () => {
    await purgeAll()
    // No pictures or card data may stay behind: the card database, the downloaded and the viewed pictures.
    await getCardDbController()?.removeAll().catch(() => {})
    await resetServiceWorker()
    toast.success(t('pwa.resetDone'))
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 py-6" data-testid="offline-center">
      <h1 className="sr-only">{t('sync.centerTitle')}</h1>

      <Section title={t('pwa.connection')}>
        <p className="text-sm text-text-primary" data-testid="connection-state" data-state={state}>{stateText}</p>
        {info && (
          <p className="text-xs text-text-muted">
            {`${t('pwa.serverVersion')}: ${info.version ?? '–'} (API ${info.apiLevel})`}
          </p>
        )}
        {live && <p className="text-xs text-text-muted">{new Date().toLocaleTimeString()}</p>}
      </Section>

      <Section title={t('sync.centerTitle')}>
        {unavailable ? (
          <p className="text-sm text-text-secondary">{t('sync.unavailableQueue')}</p>
        ) : (
          <>
            <SyncControls />
            <SyncItemList />
          </>
        )}
      </Section>

      <OfflineCardDbSection />

      <Section title={t('sync.storageTitle')}>
        {unavailable ? <p className="text-sm text-text-secondary">{t('sync.storageUnavailable')}</p> : <StorageSummary />}
      </Section>

      <Section title={t('pwa.settingsTitle')}>
        <ul className="space-y-2">
          <Capability label={t('pwa.capSecureContext')} ok={capabilities.secureContext} />
          <Capability label={t('pwa.capServiceWorker')} ok={capabilities.serviceWorker && capabilities.secureContext} />
          <Capability label={t('pwa.capStorage')} ok={capabilities.indexedDB} />
          <Capability label={t('pwa.capInstalled')} ok={capabilities.standalone} />
          <Capability label={t('pwa.capPush')} ok={capabilities.push} />
        </ul>
        {!capabilities.secureContext && <p className="text-xs text-text-secondary">{t('pwa.httpsHint')}</p>}
        <InstallHint force />
      </Section>

      <Section title={t('pwa.resetTitle')}>
        <p className="text-xs text-text-secondary">{t('pwa.resetDescription')}</p>
        <button type="button" className="btn-ghost" onClick={reset}>{t('pwa.resetAction')}</button>
      </Section>

      <p className="text-center text-xs text-text-muted">
        {`${t('pwa.version')}: ${appVersion() || '–'}${buildId ? ` · ${buildId}` : ''}`}
      </p>
    </div>
  )
}
