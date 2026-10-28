/**
 * Which rendering path the foil layers take.
 *
 * WebKit (every browser on iOS, and Safari on macOS) does not reliably honour `mix-blend-mode`
 * on layers that live inside a 3D-transformed, composited card: it falls back to normal
 * compositing, and the colour-dodge / overlay / hard-light layers, which are mostly black and
 * white, turn into an opaque coat of paint over the artwork. So on WebKit the foil is built from
 * plain translucent layers (see the `data-engine="webkit"` block in holo.css) and the blend
 * modes are used everywhere else.
 */
export function detectHoloEngine(nav = typeof navigator === 'undefined' ? null : navigator) {
  if (!nav) return 'default'
  const ua = String(nav.userAgent || '')
  if (/iP(hone|ad|od)/.test(ua)) return 'webkit'
  // iPadOS Safari reports a Mac user agent; touch points tell it apart.
  if (/Macintosh/.test(ua) && Number(nav.maxTouchPoints) > 1) return 'webkit'
  const apple = /apple/i.test(String(nav.vendor || ''))
  const chromium = /Chrome|Chromium|CriOS|Edg|OPR|Android/.test(ua)
  return apple && !chromium ? 'webkit' : 'default'
}

export const holoEngine = detectHoloEngine()
