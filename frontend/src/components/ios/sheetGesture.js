import { useCallback, useEffect, useRef } from 'react'

/**
 * Swipe-down-to-dismiss rule for sheets (design doc §6.7). Pure, so it is unit-tested.
 * Dismiss when the drag passed min(160 px, a quarter of the sheet's height), or when it was a
 * flick (faster than 0.6 px/ms) of more than 24 px. Otherwise the sheet springs back.
 *
 * dy: pixels dragged down; velocity: px/ms at release; height: the sheet's height in px.
 */
export function shouldDismiss({ dy, velocity = 0, height = 0 }) {
  if (!(dy > 0)) return false
  if (dy > Math.min(160, height * 0.25)) return true
  return velocity > 0.6 && dy > 24
}

const INTERACTIVE = 'button, a, input, select, textarea, [role="button"], [role="menuitem"]'

function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Drag handlers for a sheet's grabber and header. Spread `bind` onto those elements and give the
 * sheet panel `panelRef`. The panel follows the finger by writing its transform directly, so a
 * drag causes no React renders. `onDismiss` runs after the slide-out; `beforeDismiss` may return
 * false to veto (an unsaved-changes prompt), in which case the sheet springs back.
 */
export function useSwipeDismiss({ onDismiss, beforeDismiss, enabled = true }) {
  const panelRef = useRef(null)
  const drag = useRef(null)
  const timer = useRef(null)
  const latest = useRef({ onDismiss, beforeDismiss })
  latest.current = { onDismiss, beforeDismiss }

  useEffect(() => () => clearTimeout(timer.current), [])

  const setTransform = (panel, dy, animate) => {
    panel.style.transition = animate ? 'transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)' : 'none'
    panel.style.transform = dy ? `translateY(${dy}px)` : ''
  }

  const onPointerDown = useCallback((event) => {
    if (!enabled || (event.pointerType === 'mouse' && event.button !== 0)) return
    if (event.target.closest?.(INTERACTIVE)) return
    const panel = panelRef.current
    if (!panel) return
    clearTimeout(timer.current)
    drag.current = { startY: event.clientY, lastY: event.clientY, lastT: event.timeStamp, velocity: 0, dy: 0 }
    try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* the drag still works without capture */ }
  }, [enabled])

  const onPointerMove = useCallback((event) => {
    const state = drag.current
    const panel = panelRef.current
    if (!state || !panel) return
    const dt = event.timeStamp - state.lastT
    if (dt > 0) {
      // Smooth the instantaneous velocity a little so one jittery sample does not decide a release.
      state.velocity = 0.6 * state.velocity + 0.4 * ((event.clientY - state.lastY) / dt)
    }
    state.lastY = event.clientY
    state.lastT = event.timeStamp
    state.dy = Math.max(0, event.clientY - state.startY)
    setTransform(panel, state.dy, false)
  }, [])

  const finish = useCallback((event, cancelled) => {
    const state = drag.current
    const panel = panelRef.current
    drag.current = null
    if (!state || !panel) return
    try { event.currentTarget.releasePointerCapture?.(event.pointerId) } catch { /* already released */ }
    const height = panel.offsetHeight
    const dismiss = !cancelled && shouldDismiss({ dy: state.dy, velocity: state.velocity, height })
    const allowed = dismiss && latest.current.beforeDismiss?.() !== false
    if (!allowed) {
      setTransform(panel, 0, true)
      return
    }
    if (prefersReducedMotion()) {
      latest.current.onDismiss?.()
      return
    }
    setTransform(panel, height, true)
    timer.current = setTimeout(() => latest.current.onDismiss?.(), 280)
  }, [])

  const bind = {
    onPointerDown,
    onPointerMove,
    onPointerUp: event => finish(event, false),
    onPointerCancel: event => finish(event, true),
    style: { touchAction: 'none' },
  }

  return { panelRef, bind }
}

/** Lock page scrolling while a sheet or dialog is open, restoring the previous value. */
export function useBodyScrollLock(active) {
  useEffect(() => {
    if (!active) return undefined
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [active])
}
