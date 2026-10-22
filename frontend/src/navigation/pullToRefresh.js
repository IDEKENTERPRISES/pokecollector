// Pull to refresh on the tab roots (design doc §14 P8, Q1b). The maths and the "may a pull start
// here" rules are pure so they can be unit-tested; usePullToRefresh wires them to touch events.

import { useEffect, useRef, useState } from 'react'

export const PULL_THRESHOLD = 72 // px of (damped) pull that triggers a refresh
export const PULL_MAX = 120 // the indicator never travels further than this
export const PULL_DAMPING = 0.5 // the finger moves twice as far as the indicator
export const PULL_START_SLOP = 8 // px of downward finger travel before a pull starts

/** The indicator's travel for a raw finger travel `dy`: damped, never negative, capped. */
export function pullDistance(dy) {
  if (!Number.isFinite(dy) || dy <= 0) return 0
  return Math.min(PULL_MAX, dy * PULL_DAMPING)
}

export function pullReachedThreshold(distance) {
  return distance >= PULL_THRESHOLD
}

/**
 * Whether a touch that starts on `target` may begin a pull: the page is at the very top, one finger,
 * not inside a dialog (sheets, menus and alerts have their own scrolling), and no scroll lock is on
 * (an open sheet sets `overflow: hidden` on the body).
 */
export function canStartPull({ scrollY, touchCount, target, bodyOverflow, scrolledAncestor = false }) {
  if (scrollY > 0 || touchCount !== 1) return false
  if (bodyOverflow === 'hidden') return false
  // A drag down inside a container that is itself scrolled down scrolls that container back up.
  if (scrolledAncestor) return false
  if (target?.closest?.('[role="dialog"], [aria-modal="true"], [role="menu"], input, textarea, select')) return false
  return true
}

/** True when `target` sits inside an element (not the page) that is scrolled away from its top. */
export function hasScrolledAncestor(target) {
  for (let el = target; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight) return true
  }
  return false
}

/**
 * Pull-to-refresh state for the document: `{ distance, phase }`, phase 'idle' | 'pulling' | 'ready'
 * | 'refreshing'. `onRefresh` returns a promise; the indicator stays until it settles. Touch events
 * go on the document (the document is the scroller); the handlers are non-passive only so a pull at
 * the top can stop the browser's own rubber-band.
 */
export function usePullToRefresh({ enabled, onRefresh }) {
  const [state, setState] = useState({ distance: 0, phase: 'idle' })
  const latest = useRef(onRefresh)
  latest.current = onRefresh

  useEffect(() => {
    if (!enabled) {
      setState({ distance: 0, phase: 'idle' })
      return undefined
    }
    let startY = null
    let lastDy = 0
    let pulling = false
    let busy = false
    let alive = true

    const reset = () => {
      startY = null
      pulling = false
      if (alive) setState({ distance: 0, phase: 'idle' })
    }

    const onStart = event => {
      if (busy) return
      const allowed = canStartPull({
        scrollY: window.scrollY,
        touchCount: event.touches?.length ?? 0,
        target: event.target,
        bodyOverflow: document.body.style.overflow,
        scrolledAncestor: hasScrolledAncestor(event.target),
      })
      startY = allowed ? event.touches[0].clientY : null
      lastDy = 0
      pulling = false
    }

    const onMove = event => {
      if (startY === null || busy) return
      if (event.touches?.length !== 1 || window.scrollY > 0) {
        reset()
        return
      }
      const dy = event.touches[0].clientY - startY
      lastDy = dy
      if (!pulling && dy < PULL_START_SLOP) return
      pulling = true
      if (event.cancelable) event.preventDefault()
      const distance = pullDistance(dy)
      setState({ distance, phase: pullReachedThreshold(distance) ? 'ready' : 'pulling' })
    }

    const onEnd = async () => {
      if (startY === null || !pulling) {
        startY = null
        return
      }
      const ready = pullReachedThreshold(pullDistance(lastDy))
      startY = null
      pulling = false
      if (!ready || busy) {
        reset()
        return
      }
      busy = true
      if (alive) setState({ distance: PULL_THRESHOLD, phase: 'refreshing' })
      try {
        await latest.current?.()
      } finally {
        busy = false
        reset()
      }
    }

    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', reset, { passive: true })
    return () => {
      alive = false
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', reset)
    }
  }, [enabled])

  return state
}
