// The Who's That Pokémon share picture (engagement P7): a 1080x1920 story card drawn on a canvas on
// the device, then handed to the share sheet (Instagram shows up there) or downloaded. The layout
// is plain data (`shareImageSpec`) and the drawing only reads it, so both are unit-tested without a
// browser. Sprites come from the app's own origin (or a blob: made from it), so the canvas is never
// tainted and `toBlob` works.
import { resultGrid, streakLabel } from './daily'

export const SHARE_WIDTH = 1080
export const SHARE_HEIGHT = 1920
export const SHARE_FILE_NAME = 'whos-that-pokemon.png'
export const FALLBACK_ACCENT = '#EE1515'
const DEFAULT_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

// Instagram covers roughly the top and bottom 250 px of a story, so everything sits between.
const PANEL = { x: 90, y: 520, width: 900, height: 720, radius: 56 }
const SPRITE_SIZE = 580

/** "Wednesday, 28 October" in the trainer's language, from a local YYYY-MM-DD date. */
export function dateLabel(date, locale) {
  const [year, month, day] = String(date).split('-').map(Number)
  if (!year || !month || !day) return String(date)
  try {
    return new Date(year, month - 1, day).toLocaleDateString(locale || undefined, {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    })
  } catch {
    return String(date)
  }
}

/**
 * Everything the picture says and where it goes. `result` is the trainer's { correct } for `date`
 * and `results` the kept results (for the week of squares). A right answer shows the revealed
 * sprite; a wrong one keeps the silhouette, so the picture never gives the answer away to someone
 * who has not played yet.
 */
export function shareImageSpec({ t, date, result, results = {}, streak = 0, accent, fontFamily, locale }) {
  const correct = Boolean(result?.correct)
  const count = Math.max(0, Math.floor(Number(streak) || 0))
  return {
    width: SHARE_WIDTH,
    height: SHARE_HEIGHT,
    accent: accent || FALLBACK_ACCENT,
    fontFamily: fontFamily || DEFAULT_FONT,
    appName: t('wtp.shareApp'),
    title: t('wtp.title'),
    dateLabel: dateLabel(date, locale),
    panel: PANEL,
    silhouette: !correct,
    sprite: {
      size: SPRITE_SIZE,
      x: PANEL.x + (PANEL.width - SPRITE_SIZE) / 2,
      y: PANEL.y + (PANEL.height - SPRITE_SIZE) / 2,
    },
    correct,
    outcome: t(correct ? 'wtp.shareWon' : 'wtp.shareLost'),
    grid: resultGrid(results, date),
    streak: count > 0 ? { count, label: streakLabel(t, count) } : null,
  }
}

function roundedRect(ctx, x, y, width, height, radius) {
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, radius)
    return
  }
  const r = Math.min(radius, width / 2, height / 2)
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

/** Draws the spec. `sprite` is an image or canvas (already a silhouette when the spec says so), or null. */
export function drawShareImage(ctx, spec, sprite = null) {
  const { width, height, fontFamily } = spec
  const centre = width / 2

  ctx.fillStyle = spec.accent
  ctx.fillRect(0, 0, width, height)
  const shade = ctx.createLinearGradient(0, 0, 0, height)
  shade.addColorStop(0, 'rgba(0,0,0,0.15)')
  shade.addColorStop(1, 'rgba(0,0,0,0.78)')
  ctx.fillStyle = shade
  ctx.fillRect(0, 0, width, height)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  ctx.font = `600 44px ${fontFamily}`
  ctx.fillText(spec.appName, centre, 320)
  ctx.fillStyle = '#FFFFFF'
  ctx.font = `800 84px ${fontFamily}`
  ctx.fillText(spec.title, centre, 420)
  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  ctx.font = `500 40px ${fontFamily}`
  ctx.fillText(spec.dateLabel, centre, 484)

  const { panel } = spec
  roundedRect(ctx, panel.x, panel.y, panel.width, panel.height, panel.radius)
  ctx.fillStyle = 'rgba(0,0,0,0.3)'
  ctx.fill()
  if (sprite) {
    ctx.drawImage(sprite, spec.sprite.x, spec.sprite.y, spec.sprite.size, spec.sprite.size)
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.font = `800 360px ${fontFamily}`
    ctx.fillText('?', centre, panel.y + panel.height / 2 + 125)
  }

  ctx.fillStyle = '#FFFFFF'
  ctx.font = `800 96px ${fontFamily}`
  ctx.fillText(spec.outcome, centre, 1352)
  ctx.font = `400 72px ${fontFamily}`
  ctx.fillText(spec.grid, centre, 1450)

  if (spec.streak) {
    roundedRect(ctx, centre - 300, 1500, 600, 130, 65)
    ctx.fillStyle = 'rgba(255,255,255,0.2)'
    ctx.fill()
    ctx.fillStyle = '#FFFFFF'
    ctx.font = `800 62px ${fontFamily}`
    ctx.fillText(`\u{1F525} ${spec.streak.label}`, centre, 1586)
  }
}

/** A black copy of an image's shape: draw it, then keep only where it has pixels. */
export function silhouetteOf(image, createCanvas) {
  const canvas = createCanvas(image.naturalWidth || image.width, image.naturalHeight || image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  return canvas
}

/** The accent colour in use right now, resolved to a plain colour. */
export function currentAccent(doc = globalThis.document) {
  try {
    const root = doc?.documentElement
    const value = root ? globalThis.getComputedStyle(root).getPropertyValue('--color-accent').trim() : ''
    return value || FALLBACK_ACCENT
  } catch {
    return FALLBACK_ACCENT
  }
}

/** The page's font stack, so the picture matches the app. */
export function currentFont(doc = globalThis.document) {
  try {
    return globalThis.getComputedStyle(doc.body).fontFamily || DEFAULT_FONT
  } catch {
    return DEFAULT_FONT
  }
}

function defaultCanvas(width, height) {
  const canvas = globalThis.document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function loadImage(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null)
    const image = new Image()
    // Same-origin and blob: sprites need no CORS; the attribute only keeps a cross-origin one clean.
    if (!url.startsWith('blob:')) image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = url
  })
}

function toBlob(canvas) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob(blob => resolve(blob || null), 'image/png')
    } catch {
      resolve(null) // a tainted canvas
    }
  })
}

/**
 * Draws the picture and returns it as a PNG Blob, or null when the browser cannot. If the sprite
 * is unusable (it did not load or taints the canvas) the picture is drawn without it.
 */
export async function renderShareImage(spec, spriteUrl, { createCanvas = defaultCanvas, load = loadImage } = {}) {
  const image = await load(spriteUrl)
  for (const sprite of image ? [image, null] : [null]) {
    try {
      const canvas = createCanvas(spec.width, spec.height)
      const ctx = canvas.getContext('2d')
      drawShareImage(ctx, spec, sprite && spec.silhouette ? silhouetteOf(sprite, createCanvas) : sprite)
      const blob = await toBlob(canvas)
      if (blob) return blob
    } catch {
      // try again without the sprite
    }
  }
  return null
}

export function shareFile(blob, name = SHARE_FILE_NAME) {
  return new File([blob], name, { type: 'image/png' })
}

/** Web Share API level 2: can this device share this file? */
export function canShareFile(file, nav = globalThis.navigator) {
  try {
    return typeof nav?.share === 'function' && typeof nav?.canShare === 'function' && nav.canShare({ files: [file] }) === true
  } catch {
    return false
  }
}

function download(file, doc, urls) {
  const url = urls.createObjectURL(file)
  const link = doc.createElement('a')
  link.href = url
  link.download = file.name
  doc.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => urls.revokeObjectURL(url), 10000)
}

/**
 * Shares the picture with the system share sheet, or downloads it when files cannot be shared.
 * Resolves 'shared', 'downloaded' or 'cancelled' (the trainer closed the sheet); rejects on a real failure.
 */
export async function sharePicture(blob, { nav = globalThis.navigator, doc = globalThis.document, urls = globalThis.URL } = {}) {
  const file = shareFile(blob)
  if (canShareFile(file, nav)) {
    try {
      await nav.share({ files: [file] })
      return 'shared'
    } catch (error) {
      if (error?.name === 'AbortError') return 'cancelled'
      // Some browsers refuse a file share after the gesture is spent; a download still works.
    }
  }
  download(file, doc, urls)
  return 'downloaded'
}
