import clsx from 'clsx'

// Progress of the running sync (GET /sync/status `progress`: { kind, stage, done, total }) and the
// note about lookups that failed and are retried later. total 0 means the size is not known yet.

const STAGE_KEYS = {
  starting: 'settings.syncStageStarting',
  sets: 'settings.syncStageSets',
  cards: 'settings.syncStageCards',
  metadata: 'settings.syncStageMetadata',
  prices: 'settings.syncStagePrices',
  retrying: 'settings.syncStageRetrying',
}

/** Translation key of a stage; unknown stages show the generic "Syncing…". */
export const stageLabelKey = (stage) => STAGE_KEYS[stage] ?? 'settings.syncing'

/** 0..1, or null when the stage has no known size. */
export function progressFraction(progress) {
  const total = Number(progress?.total) || 0
  if (!progress || total <= 0) return null
  return Math.min(1, Math.max(0, (Number(progress.done) || 0) / total))
}

/** "3 of 120", or '' while the size is unknown. */
export function progressCounts(progress, t) {
  const total = Number(progress?.total) || 0
  if (!progress || total <= 0) return ''
  return t('settings.syncProgressOf')
    .replace('{done}', Math.min(Number(progress.done) || 0, total).toLocaleString())
    .replace('{total}', total.toLocaleString())
}

/** What the end-of-sync retries did, for the finished sync's result line; '' when nothing was retried. */
export function retryNote(sync, t) {
  const retry = sync?.retry
  if (!retry?.retried) return ''
  if (retry.still_failing > 0) {
    return t(retry.still_failing === 1 ? 'settings.syncStillFailingOne' : 'settings.syncStillFailing').replace('{count}', retry.still_failing)
  }
  if (retry.recovered > 0) {
    return t(retry.recovered === 1 ? 'settings.syncRetriedOkOne' : 'settings.syncRetriedOk').replace('{count}', retry.recovered)
  }
  return ''
}

/** The progress bar with its stage label and "x of y". Renders nothing when no sync is running. */
export function SyncProgressBar({ progress, t, className = '' }) {
  if (!progress) return null
  const fraction = progressFraction(progress)
  const label = t(stageLabelKey(progress.stage))
  const counts = progressCounts(progress, t)
  return (
    <div className={clsx('space-y-1.5 px-1', className)} data-testid="sync-progress">
      <div className="flex items-baseline justify-between gap-3 text-footnote">
        <span className="font-medium text-text-primary">{label}</span>
        {counts && <span className="tabular-nums text-text-secondary">{counts}</span>}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={fraction == null ? undefined : Number(progress.total)}
        aria-valuenow={fraction == null ? undefined : Math.round(Number(progress.done) || 0)}
        className="h-2 w-full overflow-hidden rounded-full bg-black/45"
        style={{ boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.12)' }}
      >
        <div
          className={clsx('h-full rounded-full bg-tint', fraction == null && 'w-1/3 motion-safe:animate-pulse')}
          style={fraction == null ? undefined : { width: `${fraction * 100}%` }}
        />
      </div>
    </div>
  )
}

/** The finished sync's retry note, shown under the sync rows. */
export function SyncResultNote({ sync, t, className = '' }) {
  const note = retryNote(sync, t)
  if (!note) return null
  return <p className={clsx('px-1 text-footnote text-text-secondary', className)} data-testid="sync-result-note">{note}</p>
}
