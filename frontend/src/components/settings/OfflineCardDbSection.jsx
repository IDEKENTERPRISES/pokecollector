import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import api from '../../api/client'
import { useAuth } from '../../contexts/AuthContext'
import { useSettings } from '../../contexts/SettingsContext'
import { useCardDb } from '../../offline/carddb/useCardDb'
import HpBar from '../ios/HpBar'
import ListRow from '../ios/ListRow'
import ListSection from '../ios/ListSection'
import Switch from '../ios/Switch'
import { tcgdexLanguageLabel } from '../../utils/tcgdexLanguages'

export function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

const fill = (template, values) => Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, value), template)

const pill = 'inline-flex min-h-[32px] items-center rounded-full px-3.5 text-subheadline font-semibold ios-press disabled:opacity-40'

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
        <button type="button" className={clsx(pill, 'bg-fill-tertiary')} onClick={() => actions.pausePictures(lang)}>{t('offlineDb.pause')}</button>
        <button type="button" className={clsx(pill, 'bg-red/15 text-red')} onClick={() => actions.cancelPictures(lang)}>{t('common.cancel')}</button>
      </span>
    )
  } else if (pictures.status === 'paused') {
    subtitle = `${t(PAUSE_REASONS[pictures.reason] ?? 'offlineDb.picturesPausedError')} · ${sets}`
    trailing = (
      <span className="flex gap-2">
        <button type="button" className={clsx(pill, 'bg-accent/20 text-tint')} onClick={() => actions.resumePictures(lang)}>{t('offlineDb.resume')}</button>
        <button type="button" className={clsx(pill, 'bg-red/15 text-red')} onClick={() => actions.removePictures(lang)}>{t('offlineDb.remove')}</button>
      </span>
    )
  } else if (pictures.status === 'complete') {
    subtitle = fill(t('offlineDb.picturesDoneSize'), { size: formatBytes(pictures.bytes ?? 0) })
    trailing = <button type="button" className={clsx(pill, 'bg-red/15 text-red')} onClick={() => actions.removePictures(lang)}>{t('offlineDb.remove')}</button>
  } else {
    subtitle = fill(t('offlineDb.picturesDownload'), { size: formatBytes(pictures.estimateBytes ?? 0) })
    trailing = (
      <button type="button" className={clsx(pill, 'bg-accent/20 text-tint')} onClick={() => actions.startPictures(lang)} data-testid={`carddb-pictures-${lang}`}>
        {t('offlineDb.download')}
      </button>
    )
  }
  return (
    <>
      <ListRow title={label} subtitle={subtitle} trailing={trailing} testId={`carddb-pictures-row-${lang}`} />
      {pictures.status === 'downloading' && (
        <div className="px-4 pb-3"><HpBar value={pictures.doneSets ?? 0} max={pictures.totalSets || 1} label={label} /></div>
      )}
    </>
  )
}

const WARMUP_KEY = ['offline-carddb-picture-warmup']

/** Admins: have the server fetch every card picture from TCGdex ahead of time (about 5 a second). */
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
    onSuccess: state => queryClient.setQueryData(WARMUP_KEY, state),
  })
  if (!data) return null
  const values = { cached: (data.cached ?? 0).toLocaleString(), total: (data.total ?? 0).toLocaleString(), error: data.error ?? '' }
  const running = Boolean(data.running)
  const complete = !running && data.total > 0 && data.cached >= data.total
  let text = fill(t('offlineDb.prepareDesc'), values)
  if (running) text = fill(t('offlineDb.prepareRunning'), values)
  else if (data.error) text = fill(t('offlineDb.prepareStopped'), values)
  return (
    <ListRow
      title={t('offlineDb.prepareTitle')}
      subtitle={text}
      trailing={(
        <button type="button" className={clsx(pill, 'bg-accent/20 text-tint')} disabled={running || complete || start.isPending} onClick={() => start.mutate()} data-testid="carddb-prepare">
          {complete ? t('offlineDb.prepareDone') : t('offlineDb.prepareStart')}
        </button>
      )}
      testId="carddb-prepare-row"
    />
  )
}

/**
 * Settings › Data & sync: the offline card database. A per-device switch (on by default), one switch
 * per language the server syncs, the last update and size, the progress, optional pictures per
 * language and "Remove from this device". Hidden when the server turned the feature off.
 */
export default function OfflineCardDbSection() {
  const { t } = useSettings()
  const db = useCardDb()
  const { user } = useAuth()
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

  const hasLocalData = Object.values(db.languages).some(info => info?.meta)
  if (!db.supported || db.serverEnabled === false || (db.serverEnabled === null && !hasLocalData)) return null

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
    <div className="space-y-4" data-testid="carddb-section">
      <ListSection header={t('offlineDb.title')} footer={t('offlineDb.description')}>
        <ListRow
          title={t('offlineDb.keep')}
          trailing={<Switch checked={db.prefs.enabled} onChange={value => actions.setEnabled(value)} label={t('offlineDb.keep')} />}
          testId="carddb-enabled"
        />
        {status && (
          <ListRow
            title={status}
            trailing={db.status === 'error' || db.status === 'offline'
              ? <button type="button" className={clsx(pill, 'bg-accent/20 text-tint')} onClick={() => actions.sync({ force: true })}>{t('offlineDb.retry')}</button>
              : undefined}
            testId="carddb-status"
          />
        )}
        {db.status === 'downloading' && progress && (
          <div className="px-4 pb-3"><HpBar value={progress.doneBytes} max={progress.totalBytes || 1} label={t('offlineDb.title')} /></div>
        )}
        {db.prefs.enabled && languages.map(lang => {
          const info = db.languages[lang]
          const meta = info?.meta
          const subtitle = meta
            ? fill(t('offlineDb.updated'), {
              date: new Date(meta.syncedAt).toLocaleDateString(),
              size: formatBytes(info.bytes),
              cards: (meta.cards ?? 0).toLocaleString(),
            })
            : t('offlineDb.notDownloaded')
          return (
            <ListRow
              key={lang}
              title={tcgdexLanguageLabel(lang, { full: true })}
              subtitle={subtitle}
              trailing={<Switch checked={db.prefs.languages[lang] !== false} onChange={value => actions.setLanguage(lang, value)} label={tcgdexLanguageLabel(lang, { full: true })} />}
              testId={`carddb-language-${lang}`}
            />
          )
        })}
        {db.prefs.enabled && languages.filter(lang => db.languages[lang]?.meta).map(lang => (
          <div key={`prices-${lang}`}>
            {db.languages[lang].meta.pricesUpdatedAt && (
              <ListRow
                title={`${t('offlineDb.pricesFrom')} ${new Date(db.languages[lang].meta.pricesUpdatedAt).toLocaleDateString()}`}
                subtitle={tcgdexLanguageLabel(lang, { full: true })}
              />
            )}
            <PicturesRow lang={lang} info={db.languages[lang]} actions={actions} t={t} />
          </div>
        ))}
        {user?.role === 'admin' && <PrepareRow t={t} />}
        {hasLocalData && (
          <ListRow title={t('offlineDb.removeAll')} destructive onClick={() => actions.removeAll()} testId="carddb-remove" />
        )}
      </ListSection>
    </div>
  )
}
