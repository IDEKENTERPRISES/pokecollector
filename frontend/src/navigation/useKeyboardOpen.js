import { useEffect, useState } from 'react'

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', ''])

// After a text field takes focus the keyboard needs a moment to slide up; until then we assume it is
// coming. Once settled, a focused field with no shrunken visual viewport means the keyboard is down
// (swiped away in a Home Screen app, or a hardware keyboard), so the tab bar must come back.
const KEYBOARD_SETTLE_MS = 700
// How much of the layout viewport the keyboard has to cover to count (the smallest iOS keyboard is far taller).
const KEYBOARD_MIN_COVER_PX = 120
// While the bar is hidden, look again now and then: a focused field removed from the page (WebKit sends
// no blur for that), or a lost event, must never leave the bar hidden for good.
const RECHECK_MS = 2000

const IOS_WEBKIT = () => Boolean(globalThis.CSS?.supports?.('-webkit-touch-callout', 'none'))

export function isTextEntry(element) {
  if (!element || element.nodeType !== 1) return false
  const tag = element.tagName
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has((element.getAttribute('type') || '').toLowerCase())
  return element.isContentEditable === true
}

/** True on a touch device with no hover, where a focused text field raises the on-screen keyboard. */
export function isTouchPrimary(win = globalThis.window) {
  return Boolean(win?.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches)
}

/**
 * Is the on-screen keyboard up? A text field must have focus. With a visual viewport, the keyboard is
 * what shrinks it below the layout viewport (pinch zoom also shrinks `height`, so it is multiplied back
 * by `scale`). Until `settled`, a focused field is assumed to be raising the keyboard.
 */
export function keyboardLikelyOpen({ textFocused, innerHeight, vvHeight, vvScale = 1, settled = true }) {
  if (!textFocused) return false
  if (!Number.isFinite(innerHeight) || !Number.isFinite(vvHeight)) return true
  const covered = innerHeight - vvHeight * (Number.isFinite(vvScale) && vvScale > 0 ? vvScale : 1)
  if (covered > KEYBOARD_MIN_COVER_PX) return true
  return !settled
}

/**
 * True while the on-screen keyboard is up (design doc §6.12), so the fixed tab bar can step aside
 * instead of floating above it. The state is re-derived from the real focus and viewport on focus
 * changes, viewport resizes, the app returning to the foreground, a rotation, a route change
 * (`resetKey`) and a slow timer, so a missed blur can never leave it stuck on.
 */
export function useKeyboardOpen(resetKey) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!isTouchPrimary()) return undefined
    let focusedAt = 0
    let blurTimer = 0
    let settleTimer = 0

    const evaluate = () => {
      // Only iOS WebKit shrinks the visual viewport for the keyboard and can keep a focused field with the
      // keyboard swiped away; elsewhere (and in emulated touch browsers) focus alone decides, as before.
      const vv = IOS_WEBKIT() ? window.visualViewport : null
      const textFocused = isTextEntry(document.activeElement)
      if (!textFocused) focusedAt = 0
      setOpen(keyboardLikelyOpen({
        textFocused,
        innerHeight: window.innerHeight,
        vvHeight: vv?.height,
        vvScale: vv?.scale,
        settled: !focusedAt || Date.now() - focusedAt >= KEYBOARD_SETTLE_MS,
      }))
    }
    const onFocusIn = event => {
      window.clearTimeout(blurTimer)
      if (isTextEntry(event.target)) {
        focusedAt = Date.now()
        window.clearTimeout(settleTimer)
        settleTimer = window.setTimeout(evaluate, KEYBOARD_SETTLE_MS + 50)
      }
      evaluate()
    }
    const onFocusOut = () => {
      window.clearTimeout(blurTimer)
      // A short delay keeps the bar from flickering while focus moves between fields.
      blurTimer = window.setTimeout(evaluate, 120)
    }
    const onVisible = () => { if (document.visibilityState !== 'hidden') evaluate() }

    const vv = window.visualViewport
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', evaluate)
    window.addEventListener('orientationchange', evaluate)
    window.addEventListener('resize', evaluate)
    vv?.addEventListener('resize', evaluate)
    // Cover the page already having a focused field when this mounts, and a route change.
    evaluate()
    return () => {
      window.clearTimeout(blurTimer)
      window.clearTimeout(settleTimer)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', evaluate)
      window.removeEventListener('orientationchange', evaluate)
      window.removeEventListener('resize', evaluate)
      vv?.removeEventListener('resize', evaluate)
    }
  }, [resetKey])

  useEffect(() => {
    if (!open) return undefined
    const timer = window.setInterval(() => {
      if (!isTextEntry(document.activeElement)) setOpen(false)
    }, RECHECK_MS)
    return () => window.clearInterval(timer)
  }, [open])

  return open
}
