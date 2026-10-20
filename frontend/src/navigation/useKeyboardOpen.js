import { useEffect, useState } from 'react'

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', ''])

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
 * True while a text-entry element has focus on a touch device (design doc §6.12), so the fixed tab
 * bar can step aside instead of floating or jumping above the iOS keyboard. A short delay on
 * blur keeps the bar from flickering while focus moves between fields.
 */
export function useKeyboardOpen() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!isTouchPrimary()) return undefined
    let timer = 0
    const onFocusIn = event => {
      window.clearTimeout(timer)
      if (isTextEntry(event.target)) setOpen(true)
    }
    const onFocusOut = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setOpen(isTextEntry(document.activeElement)), 120)
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [])

  return open
}
