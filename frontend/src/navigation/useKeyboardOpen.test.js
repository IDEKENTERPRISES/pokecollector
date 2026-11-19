import { describe, expect, it } from 'vitest'
import { isTextEntry, keyboardLikelyOpen } from './useKeyboardOpen'

const el = (tagName, type) => ({ nodeType: 1, tagName, getAttribute: () => type ?? null })

describe('isTextEntry', () => {
  it('is true for text fields and false for buttons and checkboxes', () => {
    expect(isTextEntry(el('INPUT', 'search'))).toBe(true)
    expect(isTextEntry(el('TEXTAREA'))).toBe(true)
    expect(isTextEntry(el('INPUT', 'checkbox'))).toBe(false)
    expect(isTextEntry(el('BUTTON'))).toBe(false)
    expect(isTextEntry(null)).toBe(false)
  })
})

describe('keyboardLikelyOpen', () => {
  const base = { innerHeight: 800, vvHeight: 800, vvScale: 1 }

  it('is closed with no text field focused, whatever the viewport does', () => {
    expect(keyboardLikelyOpen({ ...base, textFocused: false, vvHeight: 450 })).toBe(false)
  })

  it('is open when the visual viewport is covered by a keyboard', () => {
    expect(keyboardLikelyOpen({ ...base, textFocused: true, vvHeight: 480 })).toBe(true)
  })

  it('assumes the keyboard is coming right after focus, but not once settled', () => {
    expect(keyboardLikelyOpen({ ...base, textFocused: true, settled: false })).toBe(true)
    // Keyboard swiped away in a Home Screen app: the field keeps focus but nothing covers the page.
    expect(keyboardLikelyOpen({ ...base, textFocused: true, settled: true })).toBe(false)
  })

  it('does not take pinch zoom or a small toolbar change for a keyboard', () => {
    // Zoomed in 2x: the visual viewport is half as tall, but height * scale still fills the screen.
    expect(keyboardLikelyOpen({ innerHeight: 800, vvHeight: 400, vvScale: 2, textFocused: true })).toBe(false)
    expect(keyboardLikelyOpen({ ...base, textFocused: true, vvHeight: 750 })).toBe(false)
  })

  it('falls back to the focus alone without a visual viewport', () => {
    expect(keyboardLikelyOpen({ textFocused: true, innerHeight: 800, vvHeight: undefined })).toBe(true)
  })
})
