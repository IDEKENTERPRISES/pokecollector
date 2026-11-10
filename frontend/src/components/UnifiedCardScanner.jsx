import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Camera, Inbox, Loader2, Upload, X } from 'lucide-react'
import toast from 'react-hot-toast'

import { enqueueScanJob, getScanJobs, getScannerConfiguration } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { MAX_PHOTO_BYTES } from '../offline/constants'
import { submitScanBatch } from '../offline/ops/scanSubmit'
import { useOutbox } from '../offline/useOutbox'
import { addUpdateGuard } from '../pwa/register'
import { SCAN_JOBS_QUERY_KEY, hasActiveScanJobs, scanAttentionCount } from '../utils/scanJobs'
import { isSupportedScannerImage, SCANNER_IMAGE_ACCEPT } from '../utils/scannerImages'
import BatchCameraCapture from './BatchCameraCapture'
import ActionSheet from './ios/ActionSheet'
import Alert from './ios/Alert'
import PageSheet from './ios/PageSheet'
import PokeBall from './ios/PokeBall'
import {
  chooseCaptureMode,
  clearCameraDenied,
  isCameraDenial,
  liveCameraSupported,
  rememberCameraDenied,
} from './scanCamera'

// No hard cap on a batch. Past either of these the trainer gets a gentle warning (nothing is blocked):
// every photo is a full-resolution JPEG held in memory while staged and again in the offline outbox,
// whose own storage budget (OUTBOX_MAX_BYTES) is what a very large batch actually runs into first.
const SOFT_WARN_PHOTOS = 120
const SOFT_WARN_BYTES = 200 * 1024 * 1024

// The scan overlay (design doc §5.3): a full-screen camera with a review sheet over it, portaled to
// <body> at --z-scanner. ScannerContext mounts it outside the routed <Outlet>, so scanning works from
// every tab, offline too. Its sheets and alerts render inside the overlay element (their `container`).
export default function UnifiedCardScanner({ isOpen, onClose }) {
  const [stagedFiles, setStagedFiles] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [confirmation, setConfirmation] = useState(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [captureMode, setCaptureMode] = useState('camera')
  const [overlayEl, setOverlayEl] = useState(null)
  const cameraRef = useRef()
  const galleryRef = useRef()
  const stagedFilesRef = useRef([])
  const submittingRef = useRef(false)
  const { enabled: queueEnabled, outbox, reachability, items: outboxItems } = useOutbox()
  const reachabilityRef = useRef(reachability.state)
  const { t } = useSettings()
  const navigate = useNavigate()
  const { data: scannerConfiguration } = useQuery({
    queryKey: ['scanner-configuration'],
    queryFn: getScannerConfiguration,
    enabled: isOpen,
  })
  const { data: scanData } = useQuery({
    queryKey: SCAN_JOBS_QUERY_KEY,
    queryFn: getScanJobs,
    enabled: isOpen,
    refetchInterval: query => hasActiveScanJobs(query.state.data?.jobs || []) ? 3000 : false,
  })
  const scanJobs = scanData?.jobs || []
  const waitingBatches = (outboxItems || []).filter(item => item.type === 'scan.upload').length

  useEffect(() => {
    stagedFilesRef.current = stagedFiles
  }, [stagedFiles])

  useEffect(() => {
    reachabilityRef.current = reachability.state
  }, [reachability.state])

  // The update banner must not reload the page while photos are staged or being saved.
  useEffect(() => addUpdateGuard(() => stagedFilesRef.current.length > 0 || submittingRef.current), [])

  useEffect(() => () => {
    stagedFilesRef.current.forEach(item => URL.revokeObjectURL(item.previewUrl))
  }, [])

  // Every open starts on the camera, or on the review sheet's pickers when there is no camera.
  useEffect(() => {
    if (!isOpen) return
    const mode = chooseCaptureMode()
    setCaptureMode(mode)
    setReviewOpen(mode === 'fallback')
  }, [isOpen])

  const appendFiles = fileList => {
    const incoming = Array.from(fileList || []).filter(file => {
      if (isSupportedScannerImage(file)) return true
      toast.error(t('scanner.unsupportedImage'))
      return false
    })
    if (!incoming.length) return
    if (queueEnabled && incoming.some(file => file.size > MAX_PHOTO_BYTES)) {
      toast.error(t('sync.photoTooLarge'))
      return
    }
    const additions = incoming.map(file => ({
      id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
      file,
      previewUrl: URL.createObjectURL(file),
    }))
    // Update the ref now so rapid consecutive captures all land.
    stagedFilesRef.current = [...stagedFilesRef.current, ...additions]
    setStagedFiles(current => [...current, ...additions])
  }

  const handleCameraUnavailable = useCallback(error => {
    if (isCameraDenial(error)) rememberCameraDenied()
    setCaptureMode('fallback')
    setReviewOpen(true)
  }, [])

  const retryCamera = () => {
    clearCameraDenied()
    setCaptureMode('camera')
    setReviewOpen(false)
  }

  const removeFile = id => {
    setStagedFiles(current => {
      const removed = current.find(item => item.id === id)
      if (removed) URL.revokeObjectURL(removed.previewUrl)
      return current.filter(item => item.id !== id)
    })
  }

  const clearFiles = () => {
    stagedFilesRef.current.forEach(item => URL.revokeObjectURL(item.previewUrl))
    stagedFilesRef.current = []
    setStagedFiles([])
  }

  const finishClose = after => {
    clearFiles()
    setConfirmation(null)
    setReviewOpen(false)
    onClose?.()
    if (typeof after === 'function') after()
  }

  const requestClose = after => {
    if (stagedFiles.length) {
      setConfirmation({ type: 'close', after })
      return
    }
    finishClose(after)
  }

  const startScanning = async () => {
    if (!stagedFiles.length || submitting) return
    submittingRef.current = true
    setSubmitting(true)
    try {
      // Every photo is read on its own: combining several cards into one model call shrinks each
      // card until its number is unreadable.
      const individualPositions = stagedFiles.map((_item, position) => position)
      if (queueEnabled) {
        const result = await submitScanBatch({
          files: stagedFiles.map(item => item.file),
          individualPositions,
          outbox,
          reachability: reachabilityRef.current,
        })
        finishClose()
        // One list for the whole batch, however many uploads it was cut into.
        if (result.mode === 'sent') navigate('/scans')
        else toast.success(t('sync.savedOffline'))
        return
      }
      await enqueueScanJob(
        stagedFiles.map(item => item.file),
        individualPositions,
      )
      finishClose()
      navigate('/scans')
    } catch (error) {
      if (error?.code === 'quota' || error?.code === 'too_many_items') toast.error(t('sync.storageFull'))
      else if (error?.code === 'server_old') toast.error(t('sync.serverTooOld'))
      else if (error?.code === 'too_large' || error?.code === 'photo_too_large') toast.error(t('sync.photoTooLarge'))
      else toast.error(error?.response?.data?.detail || t('scanner.batchSubmitFailed'))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  if (!isOpen || typeof document === 'undefined') return null

  const cameraMode = captureMode === 'camera'
  const count = stagedFiles.length
  const stagedBytes = stagedFiles.reduce((total, item) => total + (item.file?.size || 0), 0)
  const bigBatch = count >= SOFT_WARN_PHOTOS || stagedBytes >= SOFT_WARN_BYTES
  const reviewTitle = t('scanner.reviewTitle').replace('{n}', String(count))
  const discardTitle = t(count === 1 ? 'scanner.discardPhotoTitle' : 'scanner.discardPhotosTitle').replace('{n}', String(count))

  // Leading: Clear (destructive) over the camera, Close when the sheet is the whole screen.
  let leading
  if (!cameraMode) leading = { label: t('common.close'), onPress: () => requestClose() }
  else if (count > 0) {
    leading = (
      <button
        type="button"
        onClick={() => setConfirmation({ type: 'clear' })}
        className="ios-press min-h-[44px] px-1 text-body text-red"
      >
        {t('scanner.clear')}
      </button>
    )
  } else leading = <span />
  const trailing = cameraMode ? { label: t('scanner.cameraDone'), onPress: () => setReviewOpen(false) } : undefined

  const reviewSheet = overlayEl && (
    <PageSheet
      isOpen={reviewOpen}
      onClose={() => (cameraMode ? setReviewOpen(false) : requestClose())}
      title={reviewTitle}
      leading={leading}
      trailing={trailing}
      container={overlayEl}
      footer={(
        <div className="space-y-2">
          <button
            type="button"
            onClick={startScanning}
            disabled={!count || submitting}
            className="btn-primary flex w-full items-center justify-center gap-2 py-3"
          >
            {submitting ? <Loader2 size={16} className="animate-spin" /> : <PokeBall size={18} />}
            <span>{submitting ? t('scanner.submittingBatch') : `${t('scanner.startScanning')} (${count})`}</span>
          </button>
        </div>
      )}
    >
      <div className="space-y-4 p-4">
        {scannerConfiguration?.visual_verification === 'disabled' && (
          <div role="status" className="rounded-xl border border-yellow/35 bg-yellow/10 px-3 py-2.5">
            <p className="text-xs font-semibold text-yellow">{t('settings.scannerDegradedTitle')}</p>
            <p className="mt-1 text-[11px] text-text-secondary">{t('settings.scannerDegradedWarning')}</p>
          </div>
        )}

        {bigBatch && (
          <div role="status" data-testid="big-batch-warning" className="rounded-xl border border-yellow/35 bg-yellow/10 px-3 py-2.5">
            <p className="text-xs font-semibold text-yellow">{t('scanner.bigBatchTitle')}</p>
            <p className="mt-1 text-[11px] text-text-secondary">{t('scanner.bigBatchBody')}</p>
          </div>
        )}

        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-text-secondary">{count} {t('scanner.photos')}</p>
          {!cameraMode && count > 0 && (
            <button type="button" onClick={() => setConfirmation({ type: 'clear' })} className="ios-press text-body text-red">
              {t('scanner.clear')}
            </button>
          )}
        </div>

        {count > 0 ? (
          <div className="grid grid-cols-3 gap-3">
            {stagedFiles.map((item, index) => (
              <div key={item.id} className="space-y-1.5">
                <div className="relative aspect-[2.5/3.5] overflow-hidden rounded-xl border border-white/10 bg-bg-surface">
                  <img src={item.previewUrl} alt="" className="h-full w-full object-contain" />
                  <span className="absolute bottom-1 left-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-bold text-white">
                    {index + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeFile(item.id)}
                    aria-label={t('common.remove')}
                    className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/75 text-white"
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-2xl border-2 border-dashed border-white/10 py-10 text-center text-sm text-text-muted">
            {t('scanner.noPhotosStaged')}
          </div>
        )}

        <div className="space-y-2">
          <p className="text-footnote font-semibold uppercase tracking-wide text-text-muted">{t('scanner.addMore')}</p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => (cameraMode ? setReviewOpen(false) : cameraRef.current?.click())}
              data-tour={cameraMode ? undefined : 'shutter'}
              className="btn-secondary flex items-center justify-center gap-2"
            >
              <Camera size={16} />
              <span>{t('scanner.takePhoto')}</span>
            </button>
            <button
              type="button"
              onClick={() => galleryRef.current?.click()}
              className="btn-secondary flex items-center justify-center gap-2"
            >
              <Upload size={16} />
              <span>{t('scanner.chooseFromLibrary')}</span>
            </button>
          </div>
          {!cameraMode && (
            // Without a camera there is no inbox button in the viewfinder: the queue stays reachable from here.
            <button
              type="button"
              data-tour="scan-queue"
              onClick={() => requestClose(() => navigate('/scans'))}
              className="btn-secondary flex w-full items-center justify-center gap-2"
            >
              <Inbox size={16} />
              <span>{t('scanner.inbox')}</span>
            </button>
          )}
          {!cameraMode && liveCameraSupported() && (
            <button type="button" onClick={retryCamera} className="ios-press w-full py-2 text-center text-body text-tint">
              {t('scanner.tryCameraAgain')}
            </button>
          )}
        </div>
      </div>
    </PageSheet>
  )

  return createPortal(
    <div
      ref={setOverlayEl}
      role="dialog"
      aria-label={t('scanner.title')}
      className="fixed inset-0 overflow-hidden bg-black"
      style={{ zIndex: 'var(--z-scanner)' }}
      onKeyDown={event => {
        if (event.key === 'Escape' && !reviewOpen && !confirmation) requestClose()
      }}
    >
      <input
        ref={cameraRef}
        type="file"
        accept={SCANNER_IMAGE_ACCEPT}
        capture="environment"
        className="hidden"
        onChange={event => {
          appendFiles(event.target.files)
          event.target.value = ''
        }}
      />
      <input
        ref={galleryRef}
        type="file"
        accept={SCANNER_IMAGE_ACCEPT}
        multiple
        className="hidden"
        onChange={event => {
          appendFiles(event.target.files)
          event.target.value = ''
        }}
      />

      {cameraMode && (
        <BatchCameraCapture
          count={count}
          lastPreview={stagedFiles[count - 1]?.previewUrl}
          attention={scanAttentionCount(scanJobs)}
          processing={hasActiveScanJobs(scanJobs)}
          waitingBatches={waitingBatches}
          onCapture={file => appendFiles([file])}
          onClose={() => requestClose()}
          onOpenInbox={() => requestClose(() => navigate('/scans'))}
          onOpenReview={() => setReviewOpen(true)}
          onPickPhotos={() => galleryRef.current?.click()}
          onUnavailable={handleCameraUnavailable}
        />
      )}

      {reviewSheet}

      {overlayEl && (
        <>
          <ActionSheet
            isOpen={confirmation?.type === 'close'}
            onClose={() => setConfirmation(null)}
            title={discardTitle}
            message={t('scanner.discardStagedConfirm')}
            cancelLabel={t('scanner.keepPhotos')}
            actions={[{
              label: t('ios.discard'),
              destructive: true,
              onSelect: () => finishClose(confirmation?.after),
            }]}
            container={overlayEl}
          />
          <Alert
            isOpen={confirmation?.type === 'clear'}
            onClose={() => setConfirmation(null)}
            title={t('scanner.clearBatch')}
            message={t('scanner.clearBatchConfirm')}
            actions={[
              { label: t('common.cancel'), style: 'cancel', onSelect: () => setConfirmation(null) },
              {
                label: t('scanner.clearBatch'),
                style: 'destructive',
                preferred: true,
                onSelect: () => {
                  clearFiles()
                  setConfirmation(null)
                },
              },
            ]}
            container={overlayEl}
          />
        </>
      )}
    </div>,
    document.body,
  )
}
