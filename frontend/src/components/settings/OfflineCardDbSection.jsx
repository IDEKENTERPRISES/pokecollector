import { Fragment, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import api from '../../api/client'
import { useAuth } from '../../contexts/AuthContext'
import { useSettings } from '../../contexts/SettingsContext'
import { UP_TO_DATE_SHOWN_MS } from '../../offline/carddb/controller'
import { useCardDb } from '../../offline/carddb/useCardDb'
import { formatSize } from '../../offline/storageBreakdown'
import HpBar from '../ios/HpBar'
import ListRow from '../ios/ListRow'
import ListSection from '../ios/ListSection'
import { tcgdexLanguageLabel } from '../../utils/tcgdexLanguages'

export const formatBytes = bytes => formatSize(Number(bytes) || 0)

/** "Today 01:58", or a short date and time for an older update. */
export function formatUpdated(timestamp, t, now = Date.now()) {
  const date = new Date(timestamp)
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (date.toDateString() === new Date(now).toDateString()) return `${t('offlineDb.today')} ${time}`
  return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}

const fill = (template, values) => Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, value), template)

// The look of Sync & offline (pages/OfflineCenter.jsx): a bordered card with a small heading, rows divided by lines,
// 14 px titles, 12 px notes and the ghost buttons of the sync controls.
const pill = 'btn-ghost-sm whitespace-normal text-center'
const tone = { neutral: '', accent: 'text-tint', danger: 'text-red' }

function Card({ title, footer, testId, children }) {
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4" data-testid={testId}>
      <h2 className="text-sm font-semibold text-text-primary">{title}</h2>
      {children}
      {footer && <p className="text-xs text-text-secondary">{footer}</p>}
    </section>
  )
}

function Row({ title, subtitle, trailing, testId, destructive = false, onPress }) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className={clsx('block break-words text-sm', destructive ? 'text-red' : 'text-text-primary')}>{title}</span>
        {subtitle && <span className="block break-words text-xs text-text-muted">{subtitle}</span>}
      </span>
      {trailing}
    </>
  )
  const classes = 'flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2 py-3 text-left'
  return (
    <li data-testid={testId} className="list-none">
      {onPress ? <button type="button" className={classes} onClick={onPress}>{body}</button> : <div className={classes}>{body}</div>}
    </li>
  )
}

function SwitchBox({ checked, onChange, label }) {
  return (
    <input
      type="checkbox"
      role="switch"
      aria-label={label}
      checked={checked}
      onChange={event => onChange(event.target.checked)}
      className="h-4 w-4 flex-shrink-0 accent-brand-red"
    />
  )
}


const PAUSE_REASONS = {
  user: 'offlineDb.picturesPausedUser',
  offline: 'offlineDb.picturesPausedOffline',
  network: 'offlineDb.picturesPausedStalled',
  timeout: 'offlineDb.picturesPausedStalled',
  server: 'offlineDb.picturesPausedServer',
  auth: 'offlineDb.picturesPausedAuth',
  storage: 'offlineDb.picturesPausedStorage',
}

export function formatDuration(seconds) {
  const total = Math.max(1, Math.round(seconds))
  if (total < 60) return `${total} s`
  if (total < 3600) return `${Math.round(total / 60)} min`
  return `${Math.floor(total / 3600)} h ${Math.round((total % 3600) / 60)} min`
}

function PicturesRow({ lang, info, actions, t }) {
  const pictures = info.pictures ?? { status: 'none' }
  const label = `${t('offlineDb.pictures')} · ${tcgdexLanguageLabel(lang)}`
  const sets = fill(t('offlineDb.picturesSets'), { done: pictures.doneSets ?? 0, total: pictures.totalSets ?? 0, size: formatBytes(pictures.bytes ?? 0) })
  let subtitle
  let trailing
  if (pictures.status === 'downloading') {
    const extras = [
      pictures.speed ? fill(t('offlineDb.picturesSpeed'), { speed: formatBytes(pictures.speed) }) : null,
      pictures.etaSeconds ? fill(t('offlineDb.picturesEta'), { time: formatDuration(pictures.etaSeconds) }) : null,
    ].filter(Boolean)
    subtitle = [sets, ...extras].join(' · ')
    trailing = (
      <span className="flex gap-2">
        <button type="button" className={clsx(pill, tone.neutral)} onClick={() => actions.pausePictures(lang)}>{t('offlineDb.pause')}</button>
        <button type="button" className={clsx(pill, tone.danger)} onClick={() => actions.cancelPictures(lang)}>{t('common.cancel')}</button>
      </span>
    )
  } else if (pictures.status === 'paused') {
    subtitle = `${t(PAUSE_REASONS[pictures.reason] ?? 'offlineDb.picturesPausedError')} · ${sets}`
    trailing = (
      <span className="flex gap-2">
        <button type="button" className={clsx(pill, tone.accent)} onClick={() => actions.resumePictures(lang)}>{t('offlineDb.resume')}</button>
        <button type="button" className={clsx(pill, tone.danger)} onClick={() => actions.removePictures(lang)}>{t('offlineDb.remove')}</button>
      </span>
    )
  } else if (pictures.status === 'complete') {
    subtitle = fill(t('offlineDb.picturesDoneSize'), { size: formatBytes(pictures.bytes ?? 0) })
    trailing = <button type="button" className={clsx(pill, tone.danger)} onClick={() => actions.removePictures(lang)}>{t('offlineDb.remove')}</button>
  } else {
    subtitle = fill(t('offlineDb.picturesDownload'), { size: formatBytes(pictures.estimateBytes ?? 0) })
    trailing = (
      <button type="button" className={clsx(pill, tone.accent)} onClick={() => actions.startPictures(lang)} data-testid={`carddb-pictures-${lang}`}>
        {t('offlineDb.download')}
      </button>
    )
  }
  return (
    <>
      <Row title={label} subtitle={subtitle} trailing={trailing} testId={`carddb-pictures-row-${lang}`} />
      {pictures.status === 'downloading' && (
        <li className="list-none pb-3"><HpBar value={pictures.doneSets ?? 0} max={pictures.totalSets || 1} label={label} /></li>
      )}
    </>
  )
}

const WARMUP_KEY = ['offline-carddb-picture-warmup']

/** Admins: have the server fetch every card picture from TCGdex ahead of time (about 5 a second).
 *  This describes the server's own picture store, never this phone. */
function PrepareRow({ t }) {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: WARMUP_KEY,
    queryFn: () => api.get('/offline/carddb/pictures-prepare').then(response => response.data),
    refetchInterval: query => (query.state.data?.running ? 3000 : false),
    retry: false,
  })
  const start = useMutation({
    mutationFn: () => api.post('/offline/carddb/pictures-prepare').then(response => response.data),
    // The start reply carries only the run state; the GET adds the real counts.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: WARMUP_KEY }),
  })
  if (!data) return null
  const missing = Math.max(0, (data.total ?? 0) - (data.cached ?? 0))
  const values = {
    cached: (data.cached ?? 0).toLocaleString(), total: (data.total ?? 0).toLocaleString(), error: data.error ?? '', missing: missing.toLocaleString(),
  }
  const running = Boolean(data.running)
  const nothingMissing = !running && missing === 0
  let text = fill(t(missing > 0 && !data.error ? 'offlineDb.prepareMissing' : 'offlineDb.prepareDesc'), values)
  if (running) text = fill(t('offlineDb.prepareRunning'), values)
  else if (data.error) text = fill(t('offlineDb.prepareStopped'), values)
  const retry = !running && missing > 0 && (data.cached ?? 0) > 0
  return (
    <ListRow
      title={t('offlineDb.prepareTitle')}
      subtitle={text}
      trailing={nothingMissing ? undefined : (
        <button type="button" className={clsx(pill, tone.accent)} disabled={running || start.isPending} onClick={() => start.mutate()} data-testid="carddb-prepare">
          {retry ? fill(t('offlineDb.prepareRetry'), values) : t('offlineDb.prepareStart')}
        </button>
      )}
      testId="carddb-prepare-row"
    />
  )
}

/**
 * Sync & offline (/offline), for every signed-in user: the offline card database. A per-device switch (on by default), one switch
 * per language the server syncs, the last update and size, the progress, optional pictures per
 * language and "Remove from this device". Hidden when the server turned the feature off.
 */
export default function OfflineCardDbSection() {
  const { t } = useSettings()
  const db = useCardDb()
  const { actions } = db

  useEffect(() => {
    if (!actions) return
    for (const lang of Object.keys(db.languages)) {
      if (db.languages[lang]?.meta && db.languages[lang]?.pictures?.totalSets === undefined) {
        actions.inspectPictures(lang).catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, Object.keys(db.languages).join(',')])

  // A download that stopped because the connection dropped or stalled continues when it is back.
  useEffect(() => {
    if (!actions) return undefined
    const resume = () => actions.resumeStalledPictures()
    window.addEventListener('online', resume)
    return () => window.removeEventListener('online', resume)
  }, [actions])

  // "Up to date" shows briefly after a check that found nothing new.
  const [, tick] = useState(0)
  useEffect(() => {
    if (!db.upToDateAt) return undefined
    const timer = window.setTimeout(() => tick(n => n + 1), Math.max(0, db.upToDateAt + UP_TO_DATE_SHOWN_MS - Date.now()) + 50)
    return () => window.clearTimeout(timer)
  }, [db.upToDateAt])
  const showUpToDate = Boolean(db.upToDateAt) && Date.now() - db.upToDateAt < UP_TO_DATE_SHOWN_MS
  const updating = db.status === 'checking' || db.status === 'downloading'

  const hasLocalData = Object.values(db.languages).some(info => info?.meta)
  if (!db.supported || db.serverEnabled === false || (db.serverEnabled === null && !hasLocalData && db.prefs.enabled)) return null

  const languages = [...new Set([...db.available, ...Object.keys(db.languages)])]
  const progress = db.progress
  let status = null
  if (db.status === 'downloading' && progress) {
    status = fill(t('offlineDb.downloading'), {
      done: progress.doneSets,
      total: progress.totalSets,
      size: formatBytes(progress.doneBytes),
      totalSize: formatBytes(progress.totalBytes),
    })
  } else if (db.status === 'checking') status = t('offlineDb.checking')
  else if (db.status === 'offline') status = t('offlineDb.waiting')
  else if (!db.storageOk) status = t('offlineDb.storageFailed')
  else if (db.status === 'error') status = t('offlineDb.failed')

  return (
    <Card title={t('offlineDb.title')} footer={t('offlineDb.description')} testId="carddb-section">
      <ul className="divide-y divide-border">
        <Row
          title={t('offlineDb.keep')}
          trailing={<SwitchBox checked={db.prefs.enabled} onChange={value => actions.setEnabled(value)} label={t('offlineDb.keep')} />}
          testId="carddb-enabled"
        />
        {/* F16a: shown when the pictures moved to the faster store and must be downloaded again. */}
        {db.picturesNeedRedownload && (
          <Row title={t('offlineDb.redownloadNotice')} testId="carddb-redownload-notice" />
        )}
        {status && (
          <Row
            title={status}
            trailing={db.status === 'error' || db.status === 'offline'
              ? <button type="button" className={clsx(pill, tone.accent)} onClick={() => actions.sync({ force: true })}>{t('offlineDb.retry')}</button>
              : undefined}
            testId="carddb-status"
          />
        )}
        {db.status === 'downloading' && progress && (
          <li className="list-none pb-3"><HpBar value={progress.doneBytes} max={progress.totalBytes || 1} label={t('offlineDb.title')} /></li>
        )}
        {!db.prefs.enabled && !hasLocalData && (
          <Row
            title={t('offlineDb.notOnDevice')}
            trailing={<button type="button" className={clsx(pill, tone.accent)} onClick={() => actions.setEnabled(true)} data-testid="carddb-download">{t('offlineDb.downloadAll')}</button>}
            testId="carddb-empty"
          />
        )}
        {db.prefs.enabled && languages.map(lang => {
          const info = db.languages[lang]
          const meta = info?.meta
          const updatedAt = Math.max(meta?.syncedAt ?? 0, db.checkedAt ?? 0)
          let when = meta ? formatUpdated(updatedAt, t) : null
          if (meta && updating) when = t('offlineDb.updating')
          else if (meta && showUpToDate) when = t('offlineDb.upToDate')
          const subtitle = meta
            ? fill(t('offlineDb.updated'), {
              date: when,
              size: formatBytes(info.bytes),
              cards: (meta.cards ?? 0).toLocaleString(),
            })
            : t('offlineDb.notDownloaded')
          return (
            <Row
              key={lang}
              title={tcgdexLanguageLabel(lang, { full: true })}
              subtitle={subtitle}
              trailing={<SwitchBox checked={db.prefs.languages[lang] !== false} onChange={value => actions.setLanguage(lang, value)} label={tcgdexLanguageLabel(lang, { full: true })} />}
              testId={`carddb-language-${lang}`}
            />
          )
        })}
        {db.prefs.enabled && languages.filter(lang => db.languages[lang]?.meta).map(lang => (
          <Fragment key={`prices-${lang}`}>
            {db.languages[lang].meta.pricesUpdatedAt && (
              <Row
                title={`${t('offlineDb.pricesFrom')} ${new Date(db.languages[lang].meta.pricesUpdatedAt).toLocaleDateString()}`}
                subtitle={tcgdexLanguageLabel(lang, { full: true })}
              />
            )}
            <PicturesRow lang={lang} info={db.languages[lang]} actions={actions} t={t} />
          </Fragment>
        ))}
        {hasLocalData && (
          <Row title={t('offlineDb.removeAll')} destructive onPress={() => actions.removeAll()} testId="carddb-remove" />
        )}
      </ul>
    </Card>
  )
}

/** Settings › Data & sync (admins): the server's own picture store. */
export function ServerPicturesSection() {
  const { t } = useSettings()
  const { user } = useAuth()
  if (user?.role !== 'admin') return null
  return (
    <div data-testid="carddb-server-section">
      <ListSection header={t('offlineDb.serverHeader')} footer={t('offlineDb.serverFooter')}>
        <PrepareRow t={t} />
      </ListSection>
    </div>
  )
}
