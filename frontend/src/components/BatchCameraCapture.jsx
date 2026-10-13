import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X } from 'lucide-react'
import toast from 'react-hot-toast'

import { useSettings } from '../contexts/SettingsContext'

// Live camera viewfinder that stays open between shots. The native
// <input capture> sheet closes after every photo (notably on iOS Safari), so
// batch scanning keeps a getUserMedia stream running and grabs frames instead.
export function liveCameraSupported() {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
}

export default function BatchCameraCapture({ isOpen, count, max, onCapture, onClose, onUnavailable }) {
  const { t } = useSettings()
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const [ready, setReady] = useState(false)
  const [flash, setFlash] = useState(false)

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    setReady(false)
  }, [])

  useEffect(() => {
    if (!isOpen) return undefined
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
      } catch {
        if (!cancelled) onUnavailable?.()
      }
    })()
    return () => {
      cancelled = true
      stopStream()
    }
    // onUnavailable is intentionally excluded: the stream should start once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, stopStream])

  const atLimit = count >= max

  const capture = () => {
    const video = videoRef.current
    if (!ready || atLimit || !video?.videoWidth) return
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

  if (!isOpen) return null

  return createPortal(
    <div className="fixed inset-0 z-[300] flex flex-col bg-black">
      <div className="flex items-center justify-between px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))] text-white">
        <p className="text-sm font-semibold">{count}/{max}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="grid h-9 w-9 place-items-center rounded-full bg-white/10"
        >
          <X size={18} />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <video ref={videoRef} playsInline muted autoPlay className="h-full w-full object-contain" />
        {!ready && (
          <div className="absolute inset-0 grid place-items-center text-white">
            <Loader2 className="animate-spin" />
          </div>
        )}
        {flash && <div className="pointer-events-none absolute inset-0 bg-white/70" />}
      </div>

      <div className="flex items-center justify-center gap-8 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-5">
        <div className="w-20" />
        <button
          type="button"
          onClick={capture}
          disabled={!ready || atLimit}
          aria-label={t('scanner.takePhoto')}
          className="grid h-[72px] w-[72px] place-items-center rounded-full border-4 border-white disabled:opacity-40"
        >
          <span className="h-14 w-14 rounded-full bg-white" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="w-20 text-center text-base font-semibold text-white"
        >
          {t('scanner.cameraDone')}
        </button>
      </div>
    </div>,
    document.body,
  )
}
