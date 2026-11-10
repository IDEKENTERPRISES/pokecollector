import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X } from 'lucide-react'
import { useDialogBehavior } from './ui/dialogBehavior'
import { useCandidateFullImage } from './ScanReview'

const MIN_SCALE = 1
const MAX_SCALE = 6
const DOUBLE_TAP_SCALE = 2.5
const DOUBLE_TAP_MS = 320
const TAP_SLOP = 12
const SWIPE_CLOSE_PX = 110

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

/**
 * Full-screen, opaque viewer for the trainer's photo and the selected match, big enough to read a card's
 * name and number. Pinch or double-tap to zoom, drag to pan, mouse wheel on a desktop; close with the
 * button, a tap on the empty background, a swipe down (while not zoomed in) or Escape. While open, the
 * segmented control flips between the photo and the match so details can be compared. The match uses the
 * high-resolution picture (from our own cache where there is one, like the comparison view).
 */
export default function ScanZoomViewer({ photoUrl, match, jobId, itemId, matchIndex = null, initial = 'photo', onClose, t }) {
  const hasPhoto = Boolean(photoUrl)
  const hasMatch = Boolean(match)
  const [which, setWhich] = useState(initial === 'match' && hasMatch ? 'match' : hasPhoto ? 'photo' : 'match')
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [dragY, setDragY] = useState(0)
  const stage = useRef(null)
  const imageRef = useRef(null)
  const pointers = useRef(new Map())
  const gesture = useRef(null)
  const lastTap = useRef({ time: 0, x: 0, y: 0 })

  const cdnFull = match?.image_hd || match?.image?.replace('/low.webp', '/high.webp') || match?.image
  const full = useCandidateFullImage(jobId, itemId, match && matchIndex != null ? matchIndex : null, cdnFull)
  const matchSrc = full || match?.image || null
  const src = which === 'photo' ? photoUrl : matchSrc
  const zoomed = view.scale > 1.01

  const reset = useCallback(() => { setView({ scale: 1, x: 0, y: 0 }); setDragY(0) }, [])
  useEffect(() => { reset() }, [which, reset])

  const closeOrReset = useCallback(() => (zoomed ? reset() : onClose()), [zoomed, reset, onClose])
  const { dialogRef, onDialogKeyDown } = useDialogBehavior(true, closeOrReset)

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [])

  // Keep the picture from being panned away entirely.
  const limit = useCallback((next) => {
    const box = stage.current?.getBoundingClientRect()
    if (!box) return next
    const maxX = Math.max(0, ((next.scale - 1) * box.width) / 2)
    const maxY = Math.max(0, ((next.scale - 1) * box.height) / 2)
    return { scale: next.scale, x: clamp(next.x, -maxX, maxX), y: clamp(next.y, -maxY, maxY) }
  }, [])

  // Zoom about a point (client coordinates), keeping what is under it in place.
  const zoomAbout = useCallback((nextScale, clientX, clientY) => {
    const box = stage.current?.getBoundingClientRect()
    setView(current => {
      const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE)
      if (scale === 1) return { scale: 1, x: 0, y: 0 }
      if (!box) return { ...current, scale }
      const px = clientX - (box.left + box.width / 2)
      const py = clientY - (box.top + box.height / 2)
      const ratio = scale / current.scale
      return limit({ scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio })
    })
  }, [limit])

  // Wheel zoom is attached natively: React's wheel listener is passive and could not stop the page scrolling.
  useEffect(() => {
    const node = stage.current
    if (!node) return undefined
    const onWheel = event => {
      event.preventDefault()
      zoomAbout(view.scale * (event.deltaY < 0 ? 1.2 : 1 / 1.2), event.clientX, event.clientY)
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [zoomAbout, view.scale])

  const distance = () => {
    const [a, b] = [...pointers.current.values()]
    return Math.hypot(a.x - b.x, a.y - b.y)
  }
  const midpoint = () => {
    const [a, b] = [...pointers.current.values()]
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  }

  const onPointerDown = event => {
    event.currentTarget.setPointerCapture?.(event.pointerId)
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.current.size === 2) {
      gesture.current = { type: 'pinch', startDistance: distance(), startScale: view.scale, last: midpoint() }
    } else {
      gesture.current = {
        type: 'single', startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY,
        moved: false, onImage: Boolean(imageRef.current?.contains(event.target)),
      }
    }
  }

  const onPointerMove = event => {
    if (!pointers.current.has(event.pointerId)) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const g = gesture.current
    if (!g) return
    if (g.type === 'pinch' && pointers.current.size >= 2) {
      const mid = midpoint()
      const nextScale = clamp(g.startScale * (distance() / g.startDistance), MIN_SCALE, MAX_SCALE)
      const dx = mid.x - g.last.x
      const dy = mid.y - g.last.y
      g.last = mid
      setView(current => {
        if (nextScale === 1) return { scale: 1, x: 0, y: 0 }
        const box = stage.current?.getBoundingClientRect()
        if (!box) return { ...current, scale: nextScale }
        const px = mid.x - (box.left + box.width / 2)
        const py = mid.y - (box.top + box.height / 2)
        const ratio = nextScale / current.scale
        return limit({ scale: nextScale, x: px - (px - current.x) * ratio + dx, y: py - (py - current.y) * ratio + dy })
      })
      return
    }
    if (g.type !== 'single') return
    const dx = event.clientX - g.lastX
    const dy = event.clientY - g.lastY
    g.lastX = event.clientX
    g.lastY = event.clientY
    if (Math.hypot(event.clientX - g.startX, event.clientY - g.startY) > TAP_SLOP) g.moved = true
    if (zoomed) {
      setView(current => limit({ ...current, x: current.x + dx, y: current.y + dy }))
    } else if (g.moved) {
      setDragY(Math.max(0, event.clientY - g.startY)) // the picture follows a swipe down
    }
  }

  const onPointerUp = event => {
    const g = gesture.current
    pointers.current.delete(event.pointerId)
    if (g?.type === 'pinch') {
      gesture.current = null
      pointers.current.clear()
      return
    }
    gesture.current = null
    if (!g) return
    if (!g.moved) {
      const now = Date.now()
      const previous = lastTap.current
      const isDouble = now - previous.time < DOUBLE_TAP_MS && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 40
      lastTap.current = { time: isDouble ? 0 : now, x: event.clientX, y: event.clientY }
      if (isDouble && g.onImage) {
        zoomAbout(zoomed ? 1 : DOUBLE_TAP_SCALE, event.clientX, event.clientY)
      } else if (!g.onImage && !zoomed) {
        onClose() // a tap on the empty background closes
      }
      return
    }
    if (!zoomed && event.clientY - g.startY > SWIPE_CLOSE_PX) onClose()
    else setDragY(0)
  }

  const onPointerCancel = event => {
    pointers.current.delete(event.pointerId)
    gesture.current = null
    setDragY(0)
  }

  const caption = which === 'photo'
    ? t('scanner.yourPhoto')
    : `${match?.name || ''} ${`${(match?.set_abbreviation || '').toUpperCase()} ${match?.number || ''}`.trim()}`.trim()

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('scanner.zoomViewerLabel')}
      tabIndex={-1}
      data-testid="scan-zoom-viewer"
      onKeyDown={onDialogKeyDown}
      className="fixed inset-0 flex flex-col bg-black text-white"
      style={{ zIndex: 70 }}
    >
      <header className="flex items-center justify-between gap-3 px-4 pb-2 pt-[max(0.75rem,var(--safe-top))]">
        <p className="min-w-0 flex-1 truncate text-headline" data-testid="scan-zoom-caption">{caption}</p>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          data-testid="scan-zoom-close"
          className="ios-press grid h-11 w-11 flex-shrink-0 place-items-center rounded-full bg-white/15"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </header>

      <div
        ref={stage}
        className="relative min-h-0 flex-1 select-none overflow-hidden"
        style={{ touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onDragStart={event => event.preventDefault()}
      >
        <div className="absolute inset-0 grid place-items-center p-2">
          {src ? (
            <img
              ref={imageRef}
              src={src}
              alt={which === 'photo' ? t('scanner.yourPhoto') : match?.name || ''}
              draggable={false}
              data-testid="scan-zoom-image"
              data-scale={view.scale.toFixed(2)}
              className="max-h-full max-w-full object-contain"
              style={{ transform: `translate(${view.x}px, ${view.y + dragY}px) scale(${view.scale})`, touchAction: 'none' }}
            />
          ) : (
            <Loader2 size={28} className="animate-spin text-white/80" aria-label={t('common.loading')} />
          )}
          {which === 'match' && !full && src && (
            <span className="pointer-events-none absolute bottom-3 rounded-full bg-black/70 p-2"><Loader2 size={18} className="animate-spin" aria-hidden="true" /></span>
          )}
        </div>
      </div>

      <footer className="flex flex-col items-center gap-2 px-4 pb-[max(1rem,var(--safe-bottom))] pt-2">
        {hasPhoto && hasMatch && (
          <div role="group" aria-label={t('scanner.zoomCompare')} className="flex w-full max-w-sm rounded-[12px] bg-white/15 p-1">
            {[['photo', t('scanner.yourPhoto')], ['match', t('scanner.zoomSelectedMatch')]].map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={which === key}
                onClick={() => setWhich(key)}
                data-testid={`scan-zoom-show-${key}`}
                className={`ios-press min-h-[44px] flex-1 rounded-[9px] px-3 text-subheadline font-semibold ${which === key ? 'bg-white text-black' : 'text-white'}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <p className="text-footnote text-white/70">{t('scanner.zoomHintGestures')}</p>
      </footer>
    </div>,
    document.body,
  )
}
