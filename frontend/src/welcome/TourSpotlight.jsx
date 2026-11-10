import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pointer } from 'lucide-react'
import { useSettings } from '../contexts/SettingsContext'
import GuideCard from './GuideCard'
import { TOUR_SECTIONS } from './tourSteps'

export const HOOK_WAIT_MS = 1500
const RING = 2
const EDGE_MARGIN = 4
const BADGE = 30
const NOTCH_GAP_BELOW = 18
const NOTCH_GAP_ABOVE = 16

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** The visible element carrying `data-tour="<id>"` (the tab hooks exist on the tab bar and on the sidebar; one is hidden). */
export function findTourTarget(id, doc = document) {
  const matches = [...doc.querySelectorAll(`[data-tour="${id}"]`)]
  return matches.find(node => node.getClientRects().length > 0) ?? null
}

function insideFixed(node) {
  for (let el = node; el && el !== document.body; el = el.parentElement) {
    if (getComputedStyle(el).position === 'fixed') return true
  }
  return false
}

// Everything behind the tour is inert except the highlighted control: walk up from it and mark each level's other children.
function applyInert(target, interactive) {
  const marked = []
  // The update banner stays above the tour and stays tappable: never inert, nor anything that holds it (its siblings are).
  const mark = (node) => {
    if (node.hasAttribute('data-tour-layer') || node.hasAttribute('data-tour-allow') || node.hasAttribute('inert')) return
    if (node.querySelector('[data-tour-allow]')) {
      ;[...node.children].forEach(mark)
      return
    }
    node.setAttribute('inert', '')
    marked.push(node)
  }
  if (!interactive || !target) {
    ;[...document.body.children].forEach(mark)
  } else {
    for (let el = target; el && el !== document.documentElement; el = el.parentElement) {
      const parent = el.parentElement
      if (!parent) break
      ;[...parent.children].forEach(sibling => { if (sibling !== el) mark(sibling) })
    }
  }
  return () => marked.forEach(node => node.removeAttribute('inert'))
}

function sameRect(a, b) {
  return a && b && ['left', 'top', 'width', 'height', 'radius'].every(key => Math.abs(a[key] - b[key]) < 0.5)
}

/**
 * The spotlight (docs/WELCOME_DESIGN.md §3.4): finds the step's `data-tour` hook (waiting up to 1.5 s for a lazy page),
 * measures it, dims everything else, rings the hole, and shows the hint card. The dim is drawn by one pointer-events:none
 * ring (a 9999 px shadow, exactly the artboards); four transparent panels around the hole take the taps, so the real
 * control gets the real tap. An info step also covers the hole.
 */
export default function TourSpotlight({ step, title, body, tap, onTap, onNext, onSkip, onMissing, finish }) {
  const { t } = useSettings()
  const [target, setTarget] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [rect, setRect] = useState(null)
  const [cardHeight, setCardHeight] = useState(0)
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight }))
  const cardRef = useRef(null)
  const burstUntil = useRef(0)
  const tapRef = useRef(onTap)
  tapRef.current = onTap
  const missingRef = useRef(onMissing)
  missingRef.current = onMissing

  // Find the hook; give up after 1.5 s.
  useEffect(() => {
    setTarget(null)
    setRect(null)
    let done = false
    let timer = null
    let observer = null
    let poll = null
    const finishWith = (node) => {
      if (done) return
      done = true
      observer?.disconnect()
      window.clearInterval(poll)
      window.clearTimeout(timer)
      if (node) setTarget(node)
      else {
        // eslint-disable-next-line no-console
        console.warn(`[tour] no "${step.target}" on this screen after ${HOOK_WAIT_MS} ms; skipping the step`)
        missingRef.current?.(step)
      }
    }
    const look = () => {
      const node = findTourTarget(step.target)
      if (node) finishWith(node)
    }
    look()
    if (!done) {
      observer = new MutationObserver(look)
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tour'] })
      poll = window.setInterval(look, 100)
      timer = window.setTimeout(() => finishWith(null), HOOK_WAIT_MS)
    }
    return () => {
      done = true
      observer?.disconnect()
      window.clearInterval(poll)
      window.clearTimeout(timer)
    }
  }, [step, attempt])

  const measure = useCallback(() => {
    if (!target) return
    // The screen it was on went away (the scanner was closed): look for it again.
    if (!target.isConnected) {
      setAttempt(count => count + 1)
      return
    }
    const box = target.getBoundingClientRect()
    if (!box.width && !box.height) return
    const pad = step.pad ?? 6
    const height = step.maxHeight ? Math.min(box.height, step.maxHeight) : box.height
    const own = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0
    const width = box.width + pad * 2
    const tall = height + pad * 2
    // The ring and its badge stay at least 4 px inside the screen, so a control at the edge (Inbox, a + button) is not clipped.
    const edge = EDGE_MARGIN + RING
    const left = Math.max(box.left - pad, edge)
    const top = Math.max(box.top - pad, edge)
    const right = Math.min(box.left - pad + width, window.innerWidth - edge)
    const next = {
      left,
      top,
      width: right - left,
      height: tall - (top - (box.top - pad)),
      radius: Math.min(Math.max(own, 8) + pad, Math.min(right - left, tall) / 2),
    }
    setRect(prev => (sameRect(prev, next) ? prev : next))
  }, [target, step])

  // Scroll the target into view if needed (the dim is already up), then keep measuring: a page slides in, fonts load,
  // the viewport turns. A burst of animation frames follows each event; a slow poll catches the rest.
  useLayoutEffect(() => {
    if (!target) return undefined
    if (!insideFixed(target)) {
      const box = target.getBoundingClientRect()
      const height = window.visualViewport?.height ?? window.innerHeight
      if (box.top < 60 || box.bottom > height - 110) target.scrollIntoView({ block: 'center', behavior: 'auto' })
    }
    let frame = 0
    const run = () => {
      measure()
      if (performance.now() < burstUntil.current) frame = requestAnimationFrame(run)
      else frame = 0
    }
    const burst = (ms = 700) => {
      burstUntil.current = performance.now() + ms
      if (!frame) frame = requestAnimationFrame(run)
    }
    const onResize = () => {
      setViewport({ width: window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight })
      burst(300)
    }
    burst(900)
    const poll = window.setInterval(measure, 400)
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => burst(300)) : null
    resizeObserver?.observe(target)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    window.addEventListener('scroll', () => burst(200), true)
    document.addEventListener('transitionend', () => burst(200), true)
    document.fonts?.ready?.then(() => burst(300))
    return () => {
      cancelAnimationFrame(frame)
      window.clearInterval(poll)
      resizeObserver?.disconnect()
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
    }
  }, [target, measure])

  // The real tap: a capture-phase click on the target counts after the app has handled it. On a control that holds
  // several buttons (the Grid | Book switch) only the one marked data-tour-tap counts.
  useEffect(() => {
    if (!target || step.kind !== 'tap') return undefined
    const onClick = (event) => {
      if (target.querySelector('[data-tour-tap]') && !event.target.closest?.('[data-tour-tap]')) return
      window.setTimeout(() => tapRef.current?.(step), 0)
    }
    target.addEventListener('click', onClick, true)
    return () => target.removeEventListener('click', onClick, true)
  }, [target, step])

  useEffect(() => applyInert(target, step.kind === 'tap'), [target, step])

  useLayoutEffect(() => {
    if (cardRef.current) setCardHeight(cardRef.current.offsetHeight)
  }, [rect, title, body, viewport.width])

  // The card takes focus at each step; the status line below announces it.
  useEffect(() => {
    if (rect) cardRef.current?.focus({ preventScroll: true })
  }, [step, !!rect]) // eslint-disable-line react-hooks/exhaustive-deps

  const sectionName = t(TOUR_SECTIONS[step.section].labelKey)
  const announcement = `${sectionName}. ${title}. ${tap ?? body}`
  const info = step.kind !== 'tap'

  let place = null
  if (rect) {
    const bottom = rect.top + rect.height
    const centerX = rect.left + rect.width / 2
    const arrowX = Math.max(12, Math.min(viewport.width - 32 - 14 - 12, centerX - 16 - 7))
    const fitsBelow = bottom + NOTCH_GAP_BELOW + cardHeight + 12 <= viewport.height && centerX >= 0
    const aboveRoom = rect.top - NOTCH_GAP_ABOVE - cardHeight >= 12
    const below = fitsBelow && (rect.top + rect.height / 2 < viewport.height * 0.6 || !aboveRoom)
    place = below || !aboveRoom
      ? { side: 'below', top: Math.min(bottom + NOTCH_GAP_BELOW, Math.max(12, viewport.height - cardHeight - 12)), arrowX }
      : { side: 'above', bottom: viewport.height - rect.top + NOTCH_GAP_ABOVE, arrowX }
  }

  const motion = reducedMotion() ? 'none' : 'left 250ms var(--ease-ios), top 250ms var(--ease-ios), width 250ms var(--ease-ios), height 250ms var(--ease-ios), border-radius 250ms var(--ease-ios)'
  const panel = 'pointer-events-auto absolute'

  return createPortal(
    <div data-tour-layer data-testid="tour-layer" className="pointer-events-none fixed inset-0" style={{ zIndex: 'var(--z-tour)' }}>
      <p role="status" aria-live="polite" className="sr-only">{rect ? announcement : ''}</p>
      {!rect && <div className="pointer-events-auto absolute inset-0 bg-black/[0.72]" data-testid="tour-waiting" aria-hidden="true" />}
      {rect && (
        <>
          <div
            aria-hidden="true"
            data-testid="tour-ring"
            className="absolute"
            style={{
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              borderRadius: rect.radius,
              boxShadow: `0 0 0 ${RING}px var(--color-tint), 0 0 0 9999px rgba(0,0,0,0.72)`,
              transition: motion,
            }}
          />
          <div className={panel} data-testid="tour-block-top" style={{ left: 0, right: 0, top: 0, height: Math.max(0, rect.top) }} />
          <div className={panel} data-testid="tour-block-bottom" style={{ left: 0, right: 0, top: rect.top + rect.height, bottom: 0 }} />
          <div className={panel} data-testid="tour-block-left" style={{ left: 0, top: rect.top, width: Math.max(0, rect.left), height: rect.height }} />
          <div className={panel} data-testid="tour-block-right" style={{ left: rect.left + rect.width, right: 0, top: rect.top, height: rect.height }} />
          {info && <div className={panel} data-testid="tour-block-hole" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />}
          {!info && (
            <span
              aria-hidden="true"
              data-testid="tour-badge"
              className="absolute grid h-[30px] w-[30px] place-items-center rounded-full bg-accent text-on-accent shadow-[0_2px_8px_rgba(0,0,0,0.5)]"
              style={{
                left: Math.max(EDGE_MARGIN, Math.min(rect.left + rect.width - 18, viewport.width - EDGE_MARGIN - BADGE)),
                top: Math.max(EDGE_MARGIN, Math.min(rect.top + rect.height - 18, viewport.height - EDGE_MARGIN - BADGE)),
                transition: motion,
              }}
            >
              <Pointer size={16} />
            </span>
          )}
          {place && (
            <div className="pointer-events-auto">
              <GuideCard
                ref={cardRef}
                step={step}
                title={title}
                body={body}
                tap={info ? null : tap}
                place={place}
                finish={finish}
                onNext={onNext}
                onSkip={onSkip}
              />
            </div>
          )}
        </>
      )}
    </div>,
    document.body,
  )
}
