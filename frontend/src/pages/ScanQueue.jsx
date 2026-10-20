import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Clock3, Loader2, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import {
  deleteScanJob,
  fetchScanJobItemImageBlob,
  getScanJob,
  getScanJobs,
  resolveAndAddScanJobItem,
  resolveScanJobItem,
  retryScanJobItem,
} from '../api/client'
import { ScanAddModal } from '../components/CardScanner'
import { CardZoomModal, ScanItemPanel, useScanItemPhoto } from '../components/ScanReview'
import Button from '../components/ios/Button'
import HpBar from '../components/ios/HpBar'
import ListRow from '../components/ios/ListRow'
import ListSection from '../components/ios/ListSection'
import PokeBall from '../components/ios/PokeBall'
import ConfirmDialog from '../components/ui/ConfirmDialog'
import { useScanner } from '../contexts/ScannerContext'
import { useSettings } from '../contexts/SettingsContext'
import { useNavBar } from '../navigation/useNavBar'
import {
  SCAN_JOBS_QUERY_KEY,
  hasActiveScanJobs,
  isScanJobActive,
  scanJobPollInterval,
} from '../utils/scanJobs'
import { formatRetryCountdown } from '../utils/retryCountdown'

function useRetryClock(enabled) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!enabled) return undefined
    setNow(Date.now())
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [enabled])

  return now
}

function expiryLabel(job, t) {
  if (!job?.expires_at) return ''
  return `${t('scanner.expiresOn')} ${new Date(job.expires_at).toLocaleDateString()}`
}

// "1 needs review", "2 need review": the verb follows the count.
function needReviewLabel(count, t) {
  return `${count} ${t(count === 1 ? 'scanner.needsReview' : 'scanner.needReview')}`
}

function JobRow({ job, onOpen, retryNow, t }) {
  const waitingOnly = Number(job.retrying || 0) > 0 && Number(job.active || 0) === Number(job.retrying || 0)
  const summary = [
    job.attention > 0 && needReviewLabel(job.attention, t),
    job.failed_attention > 0 && `${job.failed_attention} ${t('scanner.failed')}`,
  ].filter(Boolean).join(' · ')
  let status
  if (waitingOnly) {
    status = (
      <span role="status" className="flex flex-shrink-0 items-center gap-1.5 text-footnote text-text-secondary">
        <Clock3 size={13} aria-hidden="true" /> {formatRetryCountdown(job.next_retry_at, t, retryNow, job.retry_reason)}
      </span>
    )
  } else if (isScanJobActive(job)) {
    status = (
      <span role="status" className="flex flex-shrink-0 items-center gap-1.5 text-footnote text-text-secondary">
        <Loader2 size={13} className="animate-spin" aria-hidden="true" /> {t('scanner.processing')}
      </span>
    )
  } else {
    status = (
      <span className="flex-shrink-0 rounded-full bg-accent/20 px-2.5 py-0.5 text-caption-1 font-semibold text-tint">
        {job.attention} {t('scanner.ready')}
      </span>
    )
  }
  return (
    <ListRow
      onClick={() => onOpen(job.id)}
      title={`${job.processed}/${job.total} ${t('scanner.processed')}`}
      subtitle={(
        <>
          {summary && <span className="block">{summary}</span>}
          <span className="flex items-center gap-1"><Clock3 size={11} aria-hidden="true" /> {expiryLabel(job, t)}</span>
        </>
      )}
      trailing={(
        <>
          {status}
          <ChevronRight size={18} strokeWidth={2.25} className="flex-shrink-0 text-text-tertiary" aria-hidden="true" />
        </>
      )}
    />
  )
}

function JobDetail({ jobId, onObscuredChange }) {
  const { t } = useSettings()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [addSelection, setAddSelection] = useState(null)
  const [confirmation, setConfirmation] = useState(null)
  const [itemModalOpen, setItemModalOpen] = useState(false)
  // The full-screen review session: which photo is open and which of its
  // candidates. Owned here rather than by a single ScanItemPanel because
  // accepting a match from the zoom view walks on to the *next* unresolved
  // photo in the job (see openNextReview below) — a per-item panel cannot
  // see past its own item, so the page has to be the thing that remembers
  // where the reviewer is in the batch.
  const [review, setReview] = useState(null) // { itemId, matchIndex }
  // After a card is confirmed or skipped its row collapses and the control that opened the dialog
  // is gone, so focus would fall back to the page. Park it on the next photo that still needs a
  // decision instead (VoiceOver then reads that photo's name).
  const [focusItemId, setFocusItemId] = useState(null)

  useEffect(() => {
    if (focusItemId == null) return undefined
    const frame = window.requestAnimationFrame(() => {
      document.querySelector(`[data-scan-item="${focusItemId}"]`)?.focus()
      setFocusItemId(null)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusItemId])

  useEffect(() => {
    onObscuredChange(Boolean(addSelection || confirmation || itemModalOpen || review))
    return () => onObscuredChange(false)
  }, [addSelection, confirmation, itemModalOpen, review, onObscuredChange])

  const { data: job, isLoading, isError } = useQuery({
    queryKey: ['scan-job', jobId],
    queryFn: () => getScanJob(jobId),
    refetchInterval: query => scanJobPollInterval(query.state.data),
  })
  const retryNow = useRetryClock(Number(job?.retrying || 0) > 0)

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['scan-job', jobId] })
    queryClient.invalidateQueries({ queryKey: SCAN_JOBS_QUERY_KEY })
  }

  const resolveMutation = useMutation({
    mutationFn: ({ item, cardId = null }) => resolveScanJobItem(jobId, item.id, cardId),
    onSuccess: (_data, { item }) => {
      // Resolved items stay in job.items (collapsed, not removed — see
      // get_scan_job in backend/api/scan_jobs.py), so "nothing left to do"
      // means no *unresolved* item remains, not an empty list.
      const remaining = (job?.items || []).filter(
        candidate => candidate.id !== item.id && !candidate.resolved
      )
      setConfirmation(null)
      invalidate()
      if (remaining.length === 0) navigate('/scans', { replace: true })
      else setFocusItemId(remaining[0].id)
    },
    onError: error => toast.error(error?.response?.data?.detail || t('scanner.actionFailed')),
  })

  const retryMutation = useMutation({
    mutationFn: item => retryScanJobItem(jobId, item.id),
    onSuccess: invalidate,
    onError: error => toast.error(error?.response?.data?.detail || t('scanner.actionFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteScanJob(jobId),
    onSuccess: () => {
      setConfirmation(null)
      invalidate()
      navigate('/scans', { replace: true })
    },
    onError: error => toast.error(error?.response?.data?.detail || t('scanner.actionFailed')),
  })

  const dismiss = item => setConfirmation({ type: 'dismiss', item })

  const discardJob = () => setConfirmation({ type: 'discard' })

  const confirmDestructiveAction = () => {
    if (confirmation?.type === 'dismiss') resolveMutation.mutate({ item: confirmation.item })
    else if (confirmation?.type === 'discard') deleteMutation.mutate()
  }

  const items = job?.items || []
  const reviewItem = review ? items.find(candidate => candidate.id === review.itemId) : null
  const reviewMatches = reviewItem?.matches || []
  const reviewMatch = reviewMatches[review?.matchIndex] || null
  // Called unconditionally and above the early returns below: hooks cannot
  // sit behind a loading branch. It no-ops until a review is actually open.
  const reviewPhoto = useScanItemPhoto(jobId, reviewItem)

  // Walk to the next photo still worth looking at, so a batch can be cleared
  // without going back to the list between cards. Anything already
  // resolved, failed, or without candidates is skipped — there is nothing to
  // decide there.
  const openNextReview = fromItemId => {
    const start = items.findIndex(candidate => candidate.id === fromItemId)
    const ordered = [...items.slice(start + 1), ...items.slice(0, Math.max(0, start))]
    const next = ordered.find(candidate =>
      !candidate.resolved && candidate.status === 'done' && (candidate.matches || []).length)
    setReview(next ? { itemId: next.id, matchIndex: 0 } : null)
  }

  if (isLoading) {
    return <div role="status" aria-label={t('common.loading')} className="flex justify-center py-16"><Loader2 size={28} className="animate-spin text-tint" /></div>
  }
  if (isError || !job) {
    return (
      <div role="alert" className="rounded-xl bg-red/15 p-4 text-center text-subheadline text-red">
        {t('scanner.jobLoadFailed')}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-[20px] bg-card p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-headline text-text-primary">{job.processed}/{job.total} {t('scanner.processed')}</p>
            <p className="mt-1 text-footnote text-text-secondary">{expiryLabel(job, t)}</p>
          </div>
          {Number(job.retrying || 0) > 0 && Number(job.active || 0) === Number(job.retrying || 0) ? (
            <span role="status" className="flex items-center gap-1.5 text-footnote text-text-secondary">
              <Clock3 size={13} aria-hidden="true" /> {formatRetryCountdown(job.next_retry_at, t, retryNow, job.retry_reason)}
            </span>
          ) : isScanJobActive(job) && (
            <span role="status" className="flex items-center gap-1.5 text-footnote text-text-secondary">
              <Loader2 size={13} className="animate-spin" aria-hidden="true" /> {t('scanner.processing')}
            </span>
          )}
        </div>
        <HpBar className="mt-3" value={job.processed} max={job.total} label={t('scanner.processed')} />
        <p className="mt-2 text-footnote text-text-secondary">
          {job.pending + job.processing + job.retrying} {t('scanner.remaining')}
          {job.failed > 0 && ` · ${job.failed} ${t('scanner.failed')}`}
        </p>
      </div>

      <div className="space-y-3">
        {items.map(item => (
          <ScanItemPanel
            key={item.id}
            jobId={job.id}
            item={item}
            onAdd={(scanItem, match) => setAddSelection({ item: scanItem, match })}
            onRetry={itemToRetry => retryMutation.mutate(itemToRetry)}
            onDismiss={dismiss}
            onReview={(scanItem, matchIndex) => setReview({ itemId: scanItem.id, matchIndex })}
            onModalChange={setItemModalOpen}
            retryNow={retryNow}
            t={t}
          />
        ))}
      </div>

      <ListSection className="!mx-0">
        <ListRow
          destructive
          icon={Trash2}
          iconColor="var(--color-red)"
          title={t('scanner.discardJob')}
          onClick={discardJob}
          disabled={deleteMutation.isPending}
        />
      </ListSection>

      {reviewItem && reviewMatch && !addSelection && (
        <CardZoomModal
          card={reviewMatch}
          photoUrl={reviewPhoto}
          jobId={jobId}
          itemId={reviewItem.id}
          matches={reviewMatches}
          index={review.matchIndex}
          onIndex={matchIndex => setReview(current => ({ ...current, matchIndex }))}
          onAccept={reviewItem.resolved
            ? undefined
            : card => setAddSelection({ item: reviewItem, match: card, fromReview: true })}
          onClose={() => setReview(null)}
          t={t}
        />
      )}

      {addSelection && (
        <ScanAddModal
          match={addSelection.match}
          defaultLang={addSelection.item.recognized?.language || addSelection.match.lang || 'en'}
          getPhoto={() => addSelection.item.has_image
            ? fetchScanJobItemImageBlob(job.id, addSelection.item.id)
            : Promise.resolve(null)}
          addCard={async payload => {
            const result = await resolveAndAddScanJobItem(
              job.id,
              addSelection.item.id,
              {
                ...payload,
                confirmed_card_id: addSelection.match.tcg_card_id,
              },
            )
            return result.collection_item
          }}
          // Cancelling returns to the comparison for the same photo rather
          // than skipping it: backing out of the add form is not a decision
          // about the card, and silently advancing would strand the user.
          onClose={() => setAddSelection(null)}
          onAdded={() => {
            // The server has atomically added the card and resolved this item
            // before this callback runs, so a failed or duplicated request
            // can never advance the batch or increment quantity twice.
            const cameFromReview = addSelection.fromReview
            const finishedItemId = addSelection.item?.id
            const remaining = items.filter(
              candidate => candidate.id !== finishedItemId && !candidate.resolved
            )
            setAddSelection(null)
            invalidate()
            if (remaining.length === 0) navigate('/scans', { replace: true })
            else if (cameFromReview) openNextReview(finishedItemId)
            else setFocusItemId(remaining[0].id)
          }}
        />
      )}

      <ConfirmDialog
        isOpen={Boolean(confirmation)}
        onClose={() => setConfirmation(null)}
        onConfirm={confirmDestructiveAction}
        title={confirmation?.type === 'discard' ? t('scanner.discardJob') : t('scanner.dismissScan')}
        message={confirmation?.type === 'discard' ? t('scanner.discardJobConfirm') : t('scanner.dismissScanConfirm')}
        confirmLabel={confirmation?.type === 'discard' ? t('scanner.discardJob') : t('scanner.dismissScan')}
        cancelLabel={t('common.cancel')}
        isPending={deleteMutation.isPending || resolveMutation.isPending}
        destructive
      />
    </div>
  )
}

export default function ScanQueue() {
  const { t } = useSettings()
  const navigate = useNavigate()
  const { jobId } = useParams()
  const [, setIsNestedOpen] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: SCAN_JOBS_QUERY_KEY,
    queryFn: getScanJobs,
    refetchInterval: query => hasActiveScanJobs(query.state.data?.jobs || []) ? 3000 : false,
  })

  const { openScanner } = useScanner()
  const navBarOptions = useMemo(() => ({ title: t('scanner.queueTitle'), largeTitle: !jobId }), [t, jobId])
  useNavBar(navBarOptions)

  const jobs = data?.jobs || []
  const retryNow = useRetryClock(jobs.some(job => Number(job.retrying || 0) > 0))
  return (
    <div>
      <div className="space-y-4 px-4 pb-6 pt-2">
        {jobId ? (
          <JobDetail jobId={Number(jobId)} onObscuredChange={setIsNestedOpen} />
        ) : (
          <>
            <p className="text-subheadline text-text-secondary">{t('scanner.queueSubtitle')}</p>

            {isLoading ? (
              <div role="status" aria-label={t('common.loading')} className="flex justify-center py-16">
                <Loader2 size={28} className="animate-spin text-tint" />
              </div>
            ) : jobs.length === 0 ? (
              <div className="space-y-4 rounded-[20px] bg-card px-4 py-10 text-center">
                <PokeBall size={56} top="var(--color-fill)" className="mx-auto" />
                <p className="text-subheadline text-text-secondary">{t('scanner.noScans')}</p>
                <Button onClick={openScanner}>{t('scanner.goScan')}</Button>
              </div>
            ) : (
              <ListSection className="!mx-0">
                {jobs.map(job => <JobRow key={job.id} job={job} onOpen={id => navigate(`/scans/${id}`)} retryNow={retryNow} t={t} />)}
              </ListSection>
            )}
          </>
        )}
      </div>
    </div>
  )
}
