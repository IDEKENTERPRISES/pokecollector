import { useCallback, useEffect, useRef, useState } from 'react'
import { ImagePlus, Inbox, Loader2, X } from 'lucide-react'
import toast from 'react-hot-toast'

import { useSettings } from '../contexts/SettingsContext'
import Badge from './ios/Badge'
import PokeBall from './ios/PokeBall'

export { liveCameraSupported } from './scanCamera'

const GUIDE_CORNERS = [
  'left-0 top-0 rounded-tl-xl border-l-4 border-t-4',
  'right-0 top-0 rounded-tr-xl border-r-4 border-t-4',
  'bottom-0 left-0 rounded-bl-xl border-b-4 border-l-4',
  'bottom-0 right-0 rounded-br-xl border-b-4 border-r-4',
]

// Live camera screen that stays open between shots. The native <input capture> sheet closes after
// every photo (notably on iOS Safari), so batch scanning keeps a getUserMedia stream running and
// grabs frames instead. It fills the scan overlay (design doc §5.3): the overlay owns the staged
// photos, the review sheet and the pickers; this component owns the stream and the controls.
export default function BatchCameraCapture({
  count,
  max,
  lastPreview,
  attention = 0,
  processing = false,
  waitingBatches = 0,
  onCapture,
  onClose,
  onOpenInbox,
  onOpenReview,
  onPickPhotos,
  onUnavailable,
}) {
  const { t } = useSettings()
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const unavailableRef = useRef(onUnavailable)
  const [ready, setReady] = useState(false)
  const [flash, setFlash] = useState(false)

  useEffect(() => {
    unavailableRef.current = onUnavailable
  }, [onUnavailable])

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    setReady(false)
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach(track => track.stop())
          return
        }
        streamRef.current = stream
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          await video.play().catch(() => {})
        }
        setReady(true)
      } catch (error) {
        if (!cancelled) unavailableRef.current?.(error)
      }
    })()
    return () => {
      cancelled = true
      stopStream()
    }
  }, [stopStream])

  const atLimit = count >= max

  const capture = () => {
    if (atLimit) {
      toast.error(t('scanner.batchLimitReached'))
      return
    }
    const video = videoRef.current
    if (!ready || !video?.videoWidth) return
    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    canvas.toBlob(blob => {
      if (!blob) {
        toast.error(t('scanner.cameraCaptureFailed'))
        return
      }
      const file = new File([blob], `scan-${Date.now()}.jpg`, { type: 'image/jpeg' })
      onCapture(file)
      setFlash(true)
      setTimeout(() => setFlash(false), 120)
    }, 'image/jpeg', 0.92)
  }

  return (
    <div className="absolute inset-0 flex flex-col bg-black text-white" data-testid="scan-camera">
      <video ref={videoRef} playsInline muted autoPlay className="absolute inset-0 h-full w-full object-cover" />
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <div className="relative w-[70%] max-w-[360px] shadow-[0_0_0_100vmax_rgba(0,0,0,0.55)]" style={{ aspectRatio: '63 / 88' }}>
          {GUIDE_CORNERS.map(corner => (
            <span key={corner} className={`absolute h-8 w-8 border-yellow ${corner}`} />
          ))}
        </div>
      </div>
      {!ready && (
        <div className="absolute inset-0 grid place-items-center">
          <Loader2 className="animate-spin" />
        </div>
      )}
      {flash && <div className="pointer-events-none absolute inset-0 bg-white/70" />}

      <div className="relative flex items-center justify-between gap-3 px-4 pb-2 pt-[max(0.75rem,var(--safe-top))]">
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="glass ios-press grid h-11 w-11 place-items-center rounded-full"
        >
          <X size={20} aria-hidden="true" />
        </button>
        <h2 className="text-headline">{t('scanner.scanTitle')}</h2>
        <button
          type="button"
          onClick={onOpenInbox}
          aria-label={t('scanner.queueTitle')}
          className="glass ios-press flex h-11 items-center gap-2 rounded-full px-4 text-subhead font-semibold"
        >
          <Inbox size={18} aria-hidden="true" />
          <span>{t('scanner.inbox')}</span>
          <Badge count={attention} tone="yellow" />
          {attention === 0 && processing && <span aria-hidden="true" className="h-2.5 w-2.5 animate-pulse rounded-full bg-yellow" />}
        </button>
      </div>
      {waitingBatches > 0 && (
        <p role="status" className="glass relative mx-auto mt-1 rounded-full px-3 py-1 text-footnote">
          {t(waitingBatches === 1 ? 'scanner.batchWaitingOne' : 'scanner.batchesWaiting').replace('{n}', String(waitingBatches))}
        </p>
      )}

      <div className="relative mt-auto grid grid-cols-3 items-center px-6 pb-[max(1.25rem,var(--safe-bottom))] pt-5">
        <button
          type="button"
          onClick={onPickPhotos}
          disabled={atLimit}
          className="ios-press flex flex-col items-center gap-1 justify-self-start text-footnote font-semibold disabled:opacity-40"
        >
          <span className="glass grid h-11 w-11 place-items-center rounded-full"><ImagePlus size={20} aria-hidden="true" /></span>
          {t('scanner.photosLibrary')}
        </button>
        <button
          type="button"
          onClick={capture}
          disabled={!ready || atLimit}
          aria-label={t('scanner.takePhoto')}
          data-testid="scan-shutter"
          className="ios-press grid h-[82px] w-[82px] place-items-center justify-self-center rounded-full border-4 border-white disabled:opacity-40"
        >
          <PokeBall size={70} gloss />
        </button>
        <button
          type="button"
          onClick={onOpenReview}
          disabled={count === 0}
          aria-label={t('scanner.reviewTitle').replace('{n}', String(count))}
          className="ios-press flex flex-col items-center gap-1 justify-self-end text-footnote font-semibold disabled:opacity-40"
        >
          <span className="glass relative grid h-11 w-11 place-items-center overflow-hidden rounded-lg">
            {lastPreview && <img src={lastPreview} alt="" className="h-full w-full object-cover" />}
          </span>
          <span className="tabular-nums">{count > 0 ? t('scanner.caught').replace('{n}', String(count)) : ''}</span>
          <span className="tabular-nums text-text-secondary">{count}/{max}</span>
        </button>
      </div>
    </div>
  )
}
