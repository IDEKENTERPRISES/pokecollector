import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Holo-card tilt: finger/mouse drag and (after a tap) device motion, eased with a spring.
 *
 * The hook writes CSS variables on the element in `ref` (see components/holo/holo.css):
 *   --rotate-x / --rotate-y (deg), --pointer-x / --pointer-y (%), --pointer-from-left / -top /
 *   -center (0..1), --background-x / --background-y (%), --card-opacity (0..1).
 * Nothing runs while the card is at rest: the animation frame loop starts on input and stops
 * once the card has settled back. Under prefers-reduced-motion nothing moves (a static sheen).
 *
 * Returns { ref, bind, motion } where `bind` is spread on the stage element and `motion` is
 * { supported, active, toggle } for the "Tilt with your phone" control.
 */

const MAX_TILT = 14 // degrees at the card edge
const EASE_MS = 70 // time constant of the ease; frame-rate independent
const REST_SHEEN = { px: 30, py: 20, op: 0.55 }
const DRAG_SLOP = 6 // px before a press counts as a drag (and swallows the click that follows)

export const prefersReducedMotion = () => (
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
)

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

export function motionSupported() {
  if (typeof window === 'undefined' || typeof window.DeviceOrientationEvent === 'undefined') return false
  if (typeof window.DeviceOrientationEvent.requestPermission === 'function') return true // iOS
  return Boolean(window.matchMedia?.('(pointer: coarse)').matches) && 'ondeviceorientation' in window
}

function writeVars(el, c) {
  const style = el.style
  const left = c.px / 100
  const top = c.py / 100
  style.setProperty('--rotate-x', `${c.rx.toFixed(2)}deg`)
  style.setProperty('--rotate-y', `${c.ry.toFixed(2)}deg`)
  style.setProperty('--pointer-x', `${c.px.toFixed(1)}%`)
  style.setProperty('--pointer-y', `${c.py.toFixed(1)}%`)
  style.setProperty('--pointer-from-left', left.toFixed(3))
  style.setProperty('--pointer-from-top', top.toFixed(3))
  style.setProperty('--pointer-from-center', clamp(Math.hypot(top - 0.5, left - 0.5) * 2, 0, 1).toFixed(3))
  style.setProperty('--background-x', `${(37 + (c.px / 100) * 26).toFixed(1)}%`)
  style.setProperty('--background-y', `${(33 + (c.py / 100) * 34).toFixed(1)}%`)
  style.setProperty('--card-opacity', c.op.toFixed(3))
}

export function useTilt({ enabled = true } = {}) {
  const ref = useRef(null)
  const frame = useRef(null)
  const lastTime = useRef(0)
  const cur = useRef({ rx: 0, ry: 0, px: REST_SHEEN.px, py: REST_SHEEN.py, op: REST_SHEEN.op })
  const tgt = useRef({ rx: 0, ry: 0, px: REST_SHEEN.px, py: REST_SHEEN.py, op: REST_SHEEN.op })
  const drag = useRef({ id: null, startX: 0, startY: 0, moved: false })
  const hovering = useRef(false)
  const motionOn = useRef(false)
  const motionBase = useRef(null)
  const [reduced] = useState(prefersReducedMotion)
  const [motion, setMotion] = useState({ supported: false, active: false })
  const active = enabled && !reduced

  const tick = useCallback((now) => {
    frame.current = null
    const el = ref.current
    if (!el) return
    const dt = lastTime.current ? Math.min(100, now - lastTime.current) : 16
    lastTime.current = now
    const spring = 1 - Math.exp(-dt / EASE_MS)
    const c = cur.current
    const t = tgt.current
    let delta = 0
    for (const key of ['rx', 'ry', 'px', 'py', 'op']) {
      const diff = t[key] - c[key]
      c[key] += diff * spring
      delta += Math.abs(diff) * (key === 'op' ? 100 : 1)
    }
    writeVars(el, c)
    const interacting = drag.current.id !== null || hovering.current || motionOn.current
    if (interacting || delta > 0.05) {
      frame.current = requestAnimationFrame(tick)
    } else {
      Object.assign(c, t)
      writeVars(el, c)
      lastTime.current = 0
    }
  }, [])

  const wake = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(tick)
  }, [tick])

  const aim = useCallback((fx, fy) => {
    // fx, fy: 0..1 across the card
    const x = clamp(fx, 0, 1)
    const y = clamp(fy, 0, 1)
    const t = tgt.current
    t.px = x * 100
    t.py = y * 100
    t.rx = (x - 0.5) * 2 * MAX_TILT
    t.ry = -(y - 0.5) * 2 * MAX_TILT
    t.op = 1
    wake()
  }, [wake])

  const rest = useCallback(() => {
    Object.assign(tgt.current, { rx: 0, ry: 0, px: REST_SHEEN.px, py: REST_SHEEN.py, op: REST_SHEEN.op })
    wake()
  }, [wake])

  const aimFromPointer = useCallback((event) => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect || !rect.width || !rect.height) return
    aim((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height)
  }, [aim])

  const bind = {
    onPointerDown(event) {
      if (!active || (event.pointerType === 'mouse' && event.button !== 0)) return
      drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false }
      aimFromPointer(event)
    },
    onPointerMove(event) {
      if (!active) return
      const d = drag.current
      if (d.id === event.pointerId) {
        if (!d.moved && Math.hypot(event.clientX - d.startX, event.clientY - d.startY) > DRAG_SLOP) {
          d.moved = true
          // Capture only once it is a drag, so a plain tap still reaches the zoom button.
          try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* not capturable */ }
        }
        aimFromPointer(event)
      } else if (event.pointerType === 'mouse' && d.id === null) {
        hovering.current = true
        aimFromPointer(event)
      }
    },
    onPointerUp(event) {
      const d = drag.current
      if (d.id !== event.pointerId) return
      drag.current = { ...d, id: null }
      if (!motionOn.current) rest()
      else wake()
    },
    onPointerCancel(event) {
      if (drag.current.id === event.pointerId) {
        drag.current = { ...drag.current, id: null, moved: false }
        if (!motionOn.current) rest()
      }
    },
    onPointerLeave(event) {
      if (event.pointerType !== 'mouse' || drag.current.id !== null) return
      hovering.current = false
      if (!motionOn.current) rest()
    },
    // A drag that ends over the artwork must not also open the zoom overlay.
    onClickCapture(event) {
      if (drag.current.moved) {
        drag.current = { ...drag.current, moved: false }
        event.preventDefault()
        event.stopPropagation()
      }
    },
  }

  const handleOrientation = useCallback((event) => {
    if (event.gamma == null || event.beta == null) return
    const base = motionBase.current || (motionBase.current = { beta: event.beta, gamma: event.gamma })
    const fx = 0.5 + clamp(event.gamma - base.gamma, -30, 30) / 60
    const fy = 0.5 + clamp(event.beta - base.beta, -30, 30) / 60
    aim(fx, fy)
  }, [aim])

  const stopMotion = useCallback(() => {
    window.removeEventListener('deviceorientation', handleOrientation)
    motionOn.current = false
    motionBase.current = null
    setMotion(m => ({ ...m, active: false }))
    rest()
  }, [handleOrientation, rest])

  const toggle = useCallback(async () => {
    if (motionOn.current) { stopMotion(); return }
    const Orientation = window.DeviceOrientationEvent
    if (typeof Orientation?.requestPermission === 'function') {
      try {
        if (await Orientation.requestPermission() !== 'granted') return
      } catch { return }
    }
    motionBase.current = null
    motionOn.current = true
    window.addEventListener('deviceorientation', handleOrientation)
    setMotion(m => ({ ...m, active: true }))
  }, [handleOrientation, stopMotion])

  useEffect(() => {
    setMotion(m => ({ ...m, supported: active && motionSupported() }))
  }, [active])

  // Initial / static sheen.
  useEffect(() => {
    if (ref.current) writeVars(ref.current, cur.current)
  })

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    window.removeEventListener('deviceorientation', handleOrientation)
  }, [handleOrientation])

  return { ref, bind, reduced, motion: { ...motion, toggle } }
}
