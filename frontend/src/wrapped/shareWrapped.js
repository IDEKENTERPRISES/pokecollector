// The Wrapped share pictures (docs/WRAPPED_REDESIGN.md §5), drawn with Canvas 2D at 1080 × 1920:
// A, the trainer card poster (W2bShareCard), and B, the stat poster (W2bSharePoster). Both are drawn
// in the mockups' own 360 × 640 units with the canvas scaled by three, so every coordinate below
// is the mockup's. The trainer card is drawn from `trainerCardLayout`, the same layout the summary
// slide renders, so the slide and picture A show the same card. `money` masks every amount while
// hide-values is on; file names and alt text never carry an amount.
import { fill } from '../delights/delights'
import { TYPE_COLOURS } from '../components/ios/pokemon'
import { DARK_INK, FOIL_COIN_STOPS, FOIL_FRAME_STOPS, FOIL_SMALL_STOPS, GLYPHS, SPARKLE } from './theme'
import { CARD_H, CARD_W, cardColours, cssFont, fitText, trainerCardLabel, trainerCardLayout, trainerCardModel } from './trainerCard'
import { loadDisplayFont, largeImage } from './pieces'
import { monthCells, rarityOf, thousands, typePercent } from './wrapped'

export const PICTURE_W = 1080
export const PICTURE_H = 1920
const UNIT = 3 // mockup units (360 × 640) to pixels
export const PICTURE_KINDS = ['card', 'poster']

export const pictureFileName = (kind, year) => `pokecollector-wrapped-${year}-${kind === 'card' ? 'trainer-card' : 'stats'}.png`

// ── Canvas helpers ─────────────────────────────────────────────────────────
export function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

/** A CSS `linear-gradient(<angle>deg, …)` over the box, as a canvas gradient. */
export function cssLinear(ctx, angle, x, y, w, h, stops) {
  const a = (angle * Math.PI) / 180
  const dx = Math.sin(a)
  const dy = -Math.cos(a)
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2
  const cx = x + w / 2
  const cy = y + h / 2
  const gradient = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half)
  stops.forEach(([at, colour]) => gradient.addColorStop(at, colour))
  return gradient
}

const evenStops = colours => colours.map((colour, i) => [i / Math.max(1, colours.length - 1), colour])

/** An ellipse radial gradient filling the box (CSS radial-gradient with explicit radii). */
function fillEllipse(ctx, cx, cy, rx, ry, stops, box) {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(rx / ry, 1)
  const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, ry)
  stops.forEach(([at, colour]) => gradient.addColorStop(at, colour))
  ctx.fillStyle = gradient
  ctx.fillRect((box.x - cx) * (ry / rx), box.y - cy, box.w * (ry / rx), box.h)
  ctx.restore()
}

/** `radial-gradient(closest-side, colour, transparent)` in a box: the slides' glows. */
function glow(ctx, x, y, w, h, colour) {
  fillEllipse(ctx, x + w / 2, y + h / 2, w / 2, h / 2, [[0, colour], [1, 'rgba(0,0,0,0)']], { x, y, w, h })
}

/** Fine diagonal foil lines: `repeating-linear-gradient(115deg, colour 0 2px, transparent 2px period)`. */
function foilLines(ctx, w, h, colour, period = 14) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, w, h)
  ctx.clip()
  ctx.translate(w / 2, h / 2)
  ctx.rotate((25 * Math.PI) / 180)
  ctx.fillStyle = colour
  const reach = Math.hypot(w, h)
  for (let x = -reach; x < reach; x += period) ctx.fillRect(x, -reach, 2, reach * 2)
  ctx.restore()
}

/** The sparkle burst: repeating conic wedges faded out by an elliptical mask (closest-side). */
function burst(ctx, x, y, w, h, colour, on, off, stop) {
  const scale = ctx.getTransform?.().a || 1
  const canvas = makeCanvas(Math.ceil(w * scale), Math.ceil(h * scale))
  const b = canvas?.getContext('2d')
  if (!b) return
  b.scale(scale, scale)
  const cx = w / 2
  const cy = h / 2
  const r = Math.hypot(w, h)
  b.fillStyle = colour
  for (let deg = 0; deg < 360; deg += off) {
    const from = ((deg - 90) * Math.PI) / 180
    const to = ((deg + on - 90) * Math.PI) / 180
    b.beginPath()
    b.moveTo(cx, cy)
    b.arc(cx, cy, r, from, to)
    b.closePath()
    b.fill()
  }
  b.globalCompositeOperation = 'destination-in'
  fillEllipse(b, cx, cy, w / 2, h / 2, [[0, '#000'], [stop / 100, '#000'], [1, 'rgba(0,0,0,0)']], { x: 0, y: 0, w, h })
  ctx.drawImage(canvas, x, y, w, h)
}

function path2d(d) {
  return typeof Path2D === 'function' ? new Path2D(d) : null
}

function sparkle(ctx, x, y, size, colour) {
  const p = path2d(SPARKLE)
  if (!p) return
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(size / 24, size / 24)
  ctx.fillStyle = colour
  ctx.fill(p)
  ctx.restore()
}

/** An energy glyph (theme GLYPHS) centred in a `size` box at x, y. */
export function glyph(ctx, type, x, y, size, colour, width) {
  const g = GLYPHS[type] || GLYPHS.colorless
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(size / 24, size / 24)
  ctx.fillStyle = colour
  ctx.strokeStyle = colour
  ctx.lineWidth = width ?? g.width ?? 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const d of g.fill || []) {
    const p = path2d(d)
    if (p) ctx.fill(p, g.evenOdd ? 'evenodd' : 'nonzero')
  }
  for (const d of g.stroke || []) {
    const p = path2d(d)
    if (p) ctx.stroke(p)
  }
  for (const [cx, cy, r] of g.circles || []) {
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.restore()
}

const metricsCache = new Map()
function lineMetrics(ctx, font) {
  const key = ctx.font
  if (!metricsCache.has(key)) {
    const m = ctx.measureText('Hgy')
    const ascent = m.fontBoundingBoxAscent ?? font.size * 0.8
    const descent = m.fontBoundingBoxDescent ?? font.size * 0.22
    metricsCache.set(key, { ascent, descent })
  }
  return metricsCache.get(key)
}

/**
 * Draws one line of text the way CSS lays it out: `y` is the top of a line box of height `lh`,
 * and the glyphs sit centred in it (half-leading). `fillStyle` may be a gradient.
 */
export function text(ctx, item, fillStyle) {
  const { font } = item
  ctx.font = cssFont(font)
  const { ascent, descent } = lineMetrics(ctx, font)
  const baseline = item.y + (item.lh - (ascent + descent)) / 2 + ascent
  ctx.fillStyle = fillStyle
  ctx.textBaseline = 'alphabetic'
  const spacing = font.spacing || 0
  const align = item.align || 'left'
  if (!spacing) {
    ctx.textAlign = align
    ctx.fillText(item.text, item.x, baseline)
    return baseline
  }
  // Letter spacing by hand, so it works where ctx.letterSpacing does not (older Safari).
  const width = ctx.measureText(item.text).width + spacing * item.text.length
  let x = align === 'right' ? item.x - width : align === 'center' ? item.x - width / 2 : item.x
  ctx.textAlign = 'left'
  for (const ch of item.text) {
    ctx.fillText(ch, x, baseline)
    x += ctx.measureText(ch).width + spacing
  }
  return baseline
}

const textWidth = (ctx, value, font) => {
  ctx.font = cssFont(font)
  return ctx.measureText(value).width + (font.spacing || 0) * value.length
}

function withShadow(ctx, { y, blur, colour }, draw) {
  const scale = ctx.getTransform?.().a || 1
  ctx.save()
  ctx.shadowColor = colour
  ctx.shadowBlur = blur * scale
  ctx.shadowOffsetY = y * scale
  draw()
  ctx.restore()
}

/** An image, cropped like `object-fit: cover`, inside a rounded box. */
function coverImage(ctx, image, x, y, w, h, r) {
  ctx.save()
  roundRect(ctx, x, y, w, h, r)
  ctx.clip()
  const iw = image.naturalWidth || image.width
  const ih = image.naturalHeight || image.height
  const s = Math.max(w / iw, h / ih)
  ctx.drawImage(image, x + (w - iw * s) / 2, y + (h - ih * s) / 2, iw * s, ih * s)
  ctx.restore()
}

/** The original card back with the card's name (§6: never an empty box). */
export function cardBack(ctx, x, y, w, h, r, name) {
  ctx.save()
  roundRect(ctx, x, y, w, h, r)
  ctx.clip()
  ctx.fillStyle = cssLinear(ctx, 160, x, y, w, h, [[0, '#4B36B8'], [1, '#1E1650']])
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = 'rgba(255,255,255,0.09)'
  ctx.lineWidth = 2
  const reach = w + h
  for (let d = -reach; d < reach; d += 12 * Math.SQRT2) {
    ctx.beginPath()
    ctx.moveTo(x + d, y)
    ctx.lineTo(x + d + reach, y + reach)
    ctx.moveTo(x + d, y + h)
    ctx.lineTo(x + d + reach, y + h - reach)
    ctx.stroke()
  }
  const ring = Math.min(w, h) * 0.44
  const cx = x + w / 2
  const cy = y + h * (name ? 0.42 : 0.5)
  ctx.beginPath()
  ctx.arc(cx, cy, ring / 2, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(20,16,60,0.6)'
  ctx.fill()
  ctx.lineWidth = Math.max(2, ring / 18)
  ctx.strokeStyle = '#FFCB05'
  ctx.beginPath()
  ctx.arc(cx, cy, ring / 2 - ctx.lineWidth / 2, 0, Math.PI * 2)
  ctx.stroke()
  sparkle(ctx, cx - ring * 0.235, cy - ring * 0.235, ring * 0.47, '#FFCB05')
  if (name) {
    const font = { size: Math.max(10, Math.round(w / 11)), weight: 800 }
    text(ctx, { text: fitText(name, font, w - 12), x: cx, y: y + h * 0.9 - font.size * 1.15, lh: font.size * 1.15, font, align: 'center' }, '#FFFFFF')
  }
  ctx.restore()
}

/** A card picture, or the card back when it is missing. */
function cardPicture(ctx, image, x, y, w, h, r, name) {
  if (image) coverImage(ctx, image, x, y, w, h, r)
  else cardBack(ctx, x, y, w, h, r, name)
}

function setMark(ctx, x, y, size, year) {
  const cx = x + size / 2
  const cy = y + size / 2
  withShadow(ctx, { y: 10, blur: 30, colour: 'rgba(0,0,0,0.5)' }, () => {
    ctx.beginPath()
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2)
    ctx.fillStyle = typeof ctx.createConicGradient === 'function'
      ? (() => {
        const g = ctx.createConicGradient(-Math.PI / 2, cx, cy)
        evenStops(['#FFE56E', '#FF9BD2', '#9BE7FF', '#B4F5A8', '#FFE56E']).forEach(([at, c]) => g.addColorStop(at, c))
        return g
      })()
      : '#FFE56E'
    ctx.fill()
  })
  ctx.beginPath()
  ctx.arc(cx, cy, size / 2 - 4, 0, Math.PI * 2)
  ctx.fillStyle = '#121433'
  ctx.fill()
  text(ctx, { text: 'SET', x: cx, y: cy - 21, lh: 12, font: { size: 10, weight: 800, spacing: 1.5 }, align: 'center' }, '#FFE56E')
  text(ctx, { text: String(year).slice(-2), x: cx, y: cy - 9, lh: 30, font: { size: 30, weight: 900, display: true }, align: 'center' }, '#FFFFFF')
}

// ── The trainer card ───────────────────────────────────────────────────────
/** Draws the trainer card in card units (356 × 498) at the current transform. */
export function drawTrainerCard(ctx, model, image, { shadow = { y: 30, blur: 60, colour: 'rgba(0,0,0,0.5)' } } = {}) {
  const L = trainerCardLayout(model)
  const c = cardColours(model)
  withShadow(ctx, shadow, () => {
    roundRect(ctx, 0, 0, CARD_W, CARD_H, 22)
    ctx.fillStyle = cssLinear(ctx, 135, 0, 0, CARD_W, CARD_H, FOIL_FRAME_STOPS)
    ctx.fill()
  })
  ctx.save()
  roundRect(ctx, 6, 6, CARD_W - 12, CARD_H - 12, 17)
  ctx.clip()
  ctx.fillStyle = cssLinear(ctx, 165, 6, 6, CARD_W - 12, CARD_H - 12, [[0, c.face[0]], [1, c.face[1]]])
  ctx.fillRect(6, 6, CARD_W - 12, CARD_H - 12)
  ctx.save()
  ctx.translate(6, 6)
  foilLines(ctx, CARD_W - 12, CARD_H - 12, c.texture, 14)
  ctx.restore()
  ctx.restore()

  text(ctx, L.header.label, c.label)
  text(ctx, L.header.name, c.ink)
  text(ctx, L.header.persona, c.ink)
  const coin = L.header.coin
  ctx.beginPath()
  ctx.arc(coin.x + 20, coin.y + 20, 20, 0, Math.PI * 2)
  ctx.fillStyle = c.coinBorder
  ctx.fill()
  ctx.beginPath()
  ctx.arc(coin.x + 20, coin.y + 20, 18, 0, Math.PI * 2)
  ctx.fillStyle = c.coin
  ctx.fill()
  const g = model.key === 'colorless' ? 20 : 22
  glyph(ctx, model.key, coin.x + 20 - g / 2, coin.y + 20 - g / 2, g, c.glyph, model.key === 'colorless' ? 2.6 : 2.4)

  if (L.chip) {
    ctx.save()
    ctx.setLineDash([3, 3])
    ctx.lineWidth = 1.5
    ctx.strokeStyle = c.chipBorder
    roundRect(ctx, L.chip.x + 0.75, L.chip.y + 0.75, L.chip.w - 1.5, L.chip.h - 1.5, 7.25)
    ctx.stroke()
    ctx.restore()
    text(ctx, L.chip.text, c.label)
  }

  const { art, mini } = L
  ctx.save()
  roundRect(ctx, art.x, art.y, art.w, art.h, 10)
  ctx.clip()
  ctx.fillStyle = cssLinear(ctx, 160, art.x, art.y, art.w, art.h, [[0, c.artBg[0]], [1, c.artBg[1]]])
  ctx.fillRect(art.x, art.y, art.w, art.h)
  const gx = art.x + art.w * (model.light ? 0.35 : 0.3)
  const gy = art.y + art.h / 2
  const far = Math.hypot(Math.max(gx - art.x, art.x + art.w - gx), art.h / 2)
  const radial = ctx.createRadialGradient(gx, gy, 0, gx, gy, far)
  radial.addColorStop(0, c.artGlow)
  radial.addColorStop(0.6, 'rgba(0,0,0,0)')
  ctx.fillStyle = radial
  ctx.fillRect(art.x, art.y, art.w, art.h)
  ctx.restore()
  ctx.lineWidth = 3
  ctx.strokeStyle = c.artBorder
  roundRect(ctx, art.x + 1.5, art.y + 1.5, art.w - 3, art.h - 3, 8.5)
  ctx.stroke()

  if (mini) {
    ctx.save()
    ctx.translate(mini.x + mini.w / 2, mini.y + mini.h / 2)
    ctx.rotate((mini.rot * Math.PI) / 180)
    ctx.translate(-mini.w / 2, -mini.h / 2)
    if (model.light) {
      withShadow(ctx, { y: 10, blur: 22, colour: 'rgba(0,0,0,0.5)' }, () => {
        roundRect(ctx, 0, 0, mini.w, mini.h, 9)
        ctx.fillStyle = '#D8CDAE'
        ctx.fill()
      })
      cardPicture(ctx, image, 0, 0, mini.w, mini.h, 9, model.art.name)
    } else {
      withShadow(ctx, { y: 10, blur: 22, colour: 'rgba(0,0,0,0.5)' }, () => {
        roundRect(ctx, 0, 0, mini.w, mini.h, 8)
        ctx.fillStyle = cssLinear(ctx, 135, 0, 0, mini.w, mini.h, FOIL_FRAME_STOPS)
        ctx.fill()
      })
      cardPicture(ctx, image, 3, 3, mini.w - 6, mini.h - 6, 5, model.art.name)
    }
    ctx.restore()
  }
  if (L.mark) setMark(ctx, L.mark.x, L.mark.y, L.mark.size, model.year)
  for (const item of L.artItems) text(ctx, item, item.role === 'label' ? c.artLabel : item.role === 'price' ? c.price : c.ink)
  if (L.sparkle) sparkle(ctx, L.sparkle.x, L.sparkle.y, 16, '#FFFFFF')
  for (const stat of L.stats) {
    text(ctx, stat.dt, model.light ? c.soft : c.label)
    text(ctx, stat.dd, c.ink)
  }
  ctx.fillStyle = c.rule
  ctx.fillRect(20, L.footer.y, 316, 1)
  text(ctx, L.footer.rarity, c.rarity)
  text(ctx, L.footer.right, model.light ? c.soft : c.label)
}

// ── The two pictures ───────────────────────────────────────────────────────
function brandFooter(ctx, y, ink, coinDark = false) {
  const font = { size: 14, weight: 800 }
  const label = 'PokéCollector Wrapped'
  const width = 22 + 8 + textWidth(ctx, label, font)
  const x = 180 - width / 2
  ctx.beginPath()
  ctx.arc(x + 11, y + 11, 11, 0, Math.PI * 2)
  ctx.fillStyle = coinDark ? DARK_INK : cssLinear(ctx, 135, x, y, 22, 22, FOIL_COIN_STOPS)
  ctx.fill()
  sparkle(ctx, x + 5, y + 5, 12, coinDark ? '#FFCB05' : DARK_INK)
  text(ctx, { text: label, x: x + 30, y: y + 2, lh: 18, font }, ink)
}

/** A: the trainer card poster (W2bShareCard). */
export function drawCardPoster(ctx, { model, t, name }, image) {
  const p = model.palette
  ctx.fillStyle = cssLinear(ctx, 165, 0, 0, 360, 640, [[0, p.bg[0]], [0.7, p.coin[1]], [1, p.deep]])
  ctx.fillRect(0, 0, 360, 640)
  burst(ctx, -215, -20, 790, 680, model.light ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)', 6, 18, 30)
  foilLines(ctx, 360, 640, model.light ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.05)', 14)
  sparkle(ctx, 26, 150, 18, '#FFFFFF')
  sparkle(ctx, 324, 540, 14, '#C9F1FF')
  const ink = p.ink
  text(ctx, { text: fill(t('wrapped.owner'), { name: name || t('wrapped.trainer') }), x: 180, y: 62, lh: 18, font: { size: 15, weight: 800 }, align: 'center' }, model.light ? '#4A4030' : p.soft)
  text(ctx, { text: fill(t('wrapped.yearSet'), { year: model.year }), x: 180, y: 80, lh: 44, font: { size: 46, weight: 900, display: true, spacing: -0.5 }, align: 'center' }, ink)
  ctx.save()
  ctx.translate(30, 142)
  ctx.scale(300 / CARD_W, 300 / CARD_W)
  drawTrainerCard(ctx, model, image)
  ctx.restore()
  brandFooter(ctx, 586, ink)
}

const STAT_TILES = {
  cards: ['#B4441F', '#8A1D12'], pull: ['#FFE56E', '#F2A600'], streak: ['#B8441A', '#6E1A0C'],
  sets: ['#236BB4', '#123F8C'], rail: ['#343F50', '#141A24'],
}

function tile(ctx, x, y, w, h, colours, border) {
  roundRect(ctx, x, y, w, h, 14)
  ctx.fillStyle = cssLinear(ctx, 160, x, y, w, h, [[0, colours[0]], [1, colours[1]]])
  ctx.fill()
  if (border) {
    ctx.lineWidth = 1
    ctx.strokeStyle = border
    roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 13.5)
    ctx.stroke()
  }
}

/** The stat poster's tiles for this year, after the mockup's bento grid (rows 190, 100, 96, 52). */
export function statPosterPlan(o) {
  const { data, showDaily } = o
  const top = Boolean(data.best_pull)
  const streak = showDaily && data.longest_streak > 0
  const sets = data.totals.sets_completed > 0
  const rail = [
    data.badges_earned > 0 && 'badges', data.trades?.count > 0 && 'trades', data.value && 'value',
  ].filter(Boolean)
  return { top, streak, sets, rail }
}

/** B: the stat poster (W2bSharePoster). */
export function drawStatPoster(ctx, o, image) {
  const { data, t, locale, money, model, name } = o
  const plan = statPosterPlan(o)
  ctx.fillStyle = '#0F1020'
  ctx.fillRect(0, 0, 360, 640)
  fillEllipse(ctx, 180, 192, 432, 384, [[0, '#23195A'], [0.7, '#0F1020'], [1, '#0F1020']], { x: 0, y: 0, w: 360, h: 640 })
  foilLines(ctx, 360, 640, 'rgba(255,255,255,0.04)', 14)

  text(ctx, { text: fill(t('wrapped.owner'), { name: name || t('wrapped.trainer') }), x: 16, y: 54, lh: 17, font: { size: 14, weight: 800 } }, '#FFC9B8')
  const titleFont = { size: 42, weight: 900, display: true }
  const title = fill(t('wrapped.yearInCardsTitle'), { year: data.year })
  const tw = textWidth(ctx, title, titleFont)
  text(ctx, { text: title, x: 16, y: 71, lh: 38, font: titleFont },
    cssLinear(ctx, 100, 16, 71, tw, 38, [[0.1, '#FFFFFF'], [0.35, '#FFE56E'], [0.58, '#FF9BD2'], [0.8, '#9BE7FF']]))
  const rarity = rarityOf(data)
  const chipFont = { size: 12, weight: 800 }
  const chipText = `${rarity.mark} ${t(`wrapped.rarity.${rarity.key}`)}`
  const cw = textWidth(ctx, chipText, chipFont) + 16
  roundRect(ctx, 344 - cw, 85, cw, 24, 8)
  ctx.fillStyle = 'rgba(255,229,110,0.16)'
  ctx.fill()
  text(ctx, { text: chipText, x: 344 - cw + 8, y: 89, lh: 16, font: chipFont }, '#FFE56E')

  let y = 124
  // Row 1: cards added (with the month bars) and the top pull.
  const cardsW = plan.top ? 160 : 328
  tile(ctx, 16, y, cardsW, 190, STAT_TILES.cards)
  text(ctx, { text: t('wrapped.cardsAdded'), x: 28, y: y + 12, lh: 15, font: { size: 12, weight: 700 } }, '#FFE5DC')
  text(ctx, { text: thousands(data.totals.cards, locale), x: 28, y: y + 33, lh: 60, font: { size: 70, weight: 900, display: true } }, '#FFFFFF')
  const chart = monthCells(data)
  if (chart) {
    const bw = (cardsW - 24 - 11 * 3) / 12
    chart.cells.forEach((cell, i) => {
      const bx = 28 + i * (bw + 3)
      const base = y + 190 - 12
      if (cell.untracked) {
        ctx.save()
        ctx.setLineDash([2, 2])
        ctx.lineWidth = 1.5
        ctx.strokeStyle = 'rgba(255,255,255,0.6)'
        roundRect(ctx, bx + 0.75, base - 10 + 0.75, bw - 1.5, 8.5, 2)
        ctx.stroke()
        ctx.restore()
        return
      }
      const h = Math.max(3, Math.round(cell.ratio * 44))
      roundRect(ctx, bx, base - h, bw, h, 2)
      ctx.fillStyle = cell.top ? '#FFCB05' : 'rgba(255,255,255,0.7)'
      ctx.fill()
    })
  }
  if (plan.top) {
    const pull = data.best_pull
    tile(ctx, 184, y, 160, 190, STAT_TILES.pull)
    text(ctx, { text: t('wrapped.topPullShort'), x: 196, y: y + 12, lh: 15, font: { size: 12, weight: 800 } }, DARK_INK)
    ctx.save()
    ctx.translate(264, y + 31 + 45)
    ctx.rotate((-4 * Math.PI) / 180)
    ctx.translate(-32, -45)
    withShadow(ctx, { y: 8, blur: 16, colour: 'rgba(90,60,0,0.35)' }, () => {
      roundRect(ctx, 0, 0, 64, 90, 6)
      ctx.fillStyle = cssLinear(ctx, 135, 0, 0, 64, 90, FOIL_SMALL_STOPS)
      ctx.fill()
    })
    cardPicture(ctx, image, 2, 2, 60, 86, 4, pull.name)
    ctx.restore()
    const nameFont = { size: 14, weight: 800 }
    text(ctx, { text: fitText(pull.name, nameFont, 136), x: 264, y: y + 127, lh: 17, font: nameFont, align: 'center' }, DARK_INK)
    if (pull.price > 0) {
      const priceFont = { size: 22, weight: 900, display: true }
      const price = money(pull.price)
      const pw = textWidth(ctx, price, priceFont) + 20
      roundRect(ctx, 264 - pw / 2, y + 147, pw, 28, 8)
      ctx.fillStyle = DARK_INK
      ctx.fill()
      text(ctx, { text: price, x: 264, y: y + 149, lh: 24, font: priceFont, align: 'center' }, '#FFCB05')
    }
  }
  y += 198

  // Row 2: the trainer type (or the Pokémon of the year when there is no persona).
  const p = model.palette
  const persona = Boolean(data.top_type)
  tile(ctx, 16, y, 328, 100, [p.bg[0], TYPE_COLOURS[model.key]?.bottom || p.bg[1]])
  const ink = p.ink
  const percent = persona ? typePercent(data) : 100
  const cx = 30 + 32
  const cy = y + 50
  ctx.beginPath()
  ctx.arc(cx, cy, 32, 0, Math.PI * 2)
  ctx.fillStyle = model.light ? 'rgba(29,22,0,0.15)' : 'rgba(255,255,255,0.18)'
  ctx.fill()
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.arc(cx, cy, 32, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * percent) / 100)
  ctx.closePath()
  ctx.fillStyle = model.light ? DARK_INK : p.light
  ctx.fill()
  ctx.beginPath()
  ctx.arc(cx, cy, 26, 0, Math.PI * 2)
  ctx.fillStyle = p.bg[1]
  ctx.fill()
  glyph(ctx, model.key, cx - 13, cy - 13, 26, ink, model.key === 'colorless' ? 2.6 : 2.2)
  const personaLine = [
    data.top_type && percent > 0 && `${percent}% ${t(`wrapped.types.${model.key}`)}`,
    data.top_pokemon && fill(t('wrapped.ofTheYear'), { name: data.top_pokemon.name }),
  ].filter(Boolean).join(' · ')
  text(ctx, { text: t('wrapped.trainerTypeShort'), x: 108, y: y + 17, lh: 15, font: { size: 12, weight: 700 } }, model.light ? '#3A3220' : p.soft)
  text(ctx, { text: fitText(model.persona, { size: 38, weight: 900, display: true }, 222), x: 108, y: y + 32, lh: 36, font: { size: 38, weight: 900, display: true } }, ink)
  if (personaLine) text(ctx, { text: fitText(personaLine, { size: 12, weight: 700 }, 222), x: 108, y: y + 68, lh: 15, font: { size: 12, weight: 700 } }, model.light ? '#3A3220' : p.soft)
  y += 108

  // Row 3: longest streak and sets completed (one spans both columns when the other is missing).
  const pair = [
    plan.streak && { colours: STAT_TILES.streak, label: t('wrapped.longestStreakTitle'), soft: '#FFE5DC', value: thousands(data.longest_streak, locale), unit: t(data.longest_streak === 1 ? 'wrapped.dayUnitOne' : 'wrapped.dayUnit') },
    plan.sets && { colours: STAT_TILES.sets, label: t('wrapped.setsCompleted'), soft: '#DCEBFF', value: thousands(data.totals.sets_completed, locale), unit: t(data.totals.sets_completed === 1 ? 'wrapped.setOne' : 'wrapped.sets') },
  ].filter(Boolean)
  if (pair.length) {
    const w = pair.length === 1 ? 328 : 160
    pair.forEach((item, i) => {
      const x = 16 + i * 168
      tile(ctx, x, y, w, 96, item.colours)
      text(ctx, { text: item.label, x: x + 12, y: y + 12, lh: 15, font: { size: 12, weight: 700 } }, item.soft)
      const big = { size: 46, weight: 900, display: true }
      const baseline = text(ctx, { text: item.value, x: x + 12, y: y + 31, lh: 41.4, font: big }, '#FFFFFF')
      const vw = textWidth(ctx, item.value, big)
      ctx.font = cssFont({ size: 20, weight: 900, display: true })
      ctx.textAlign = 'left'
      ctx.fillText(` ${item.unit}`, x + 12 + vw, baseline)
    })
    y += 104
  }

  // Row 4: the rail of small numbers.
  if (plan.rail.length) {
    tile(ctx, 16, y, 328, 52, STAT_TILES.rail, 'rgba(255,203,5,0.35)')
    const items = plan.rail.map(key => {
      if (key === 'badges') return { text: fill(t(data.badges_earned === 1 ? 'wrapped.badgeCountOne' : 'wrapped.badgeCount'), { count: thousands(data.badges_earned, locale) }), colour: '#FFE56E' }
      if (key === 'trades') return { text: fill(t(data.trades.count === 1 ? 'wrapped.tradeCountOne' : 'wrapped.tradeCount'), { count: thousands(data.trades.count, locale) }), colour: '#FFFFFF' }
      return { text: fill(t('wrapped.collectionValue'), { amount: money(data.value.end) }), colour: '#FFFFFF' }
    })
    const font = { size: 14, weight: 800 }
    const widths = items.map(item => textWidth(ctx, item.text, font))
    const free = 300 - widths.reduce((a, b) => a + b, 0)
    const gap = items.length > 1 ? free / (items.length - 1) : 0
    let x = items.length > 1 ? 30 : 180 - widths[0] / 2
    items.forEach((item, i) => {
      text(ctx, { text: item.text, x, y: y + 17, lh: 18, font }, item.colour)
      x += widths[i] + gap
    })
  }
  brandFooter(ctx, 590, '#FFFFFF')
}

// ── Rendering ──────────────────────────────────────────────────────────────
function makeCanvas(width, height) {
  try {
    const canvas = globalThis.document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
  } catch {
    return null
  }
}

function loadImage(url) {
  return new Promise(resolve => {
    if (!url || typeof Image === 'undefined') return resolve(null)
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = url
  })
}

const toBlob = canvas => new Promise(resolve => {
  try {
    canvas.toBlob(blob => resolve(blob || null), 'image/png')
  } catch {
    resolve(null)
  }
})

/** Everything a picture needs, from the story's data and settings. */
export function pictureOptions({ data, t, locale, name, money, showDaily }) {
  const model = trainerCardModel({ data, t, name, locale, money, showDaily, footer: fill(t('wrapped.cardFooterYear'), { year: data.year }) })
  return { data, t, locale, name, money, showDaily, model }
}

/** Alt text for a picture: what it shows, never an amount. */
export function pictureAlt(kind, o) {
  const { t } = o
  const label = trainerCardLabel(o.model, t, { withAmounts: false })
  return fill(t(kind === 'card' ? 'wrapped.altCard' : 'wrapped.altPoster'), { details: label })
}

/** Draws picture `kind` onto a new canvas and returns it (or null without canvas support). */
export async function drawPicture(kind, o, { load = loadImage } = {}) {
  await loadDisplayFont()
  const card = o.data.best_pull || o.data.first_card
  const imageUrl = kind === 'poster' ? o.data.best_pull?.image : card?.image
  const image = await load(largeImage(imageUrl))
  for (const attempt of image ? [image, null] : [null]) {
    const canvas = makeCanvas(PICTURE_W, PICTURE_H)
    const ctx = canvas?.getContext('2d')
    if (!ctx) return null
    ctx.scale(UNIT, UNIT)
    if (kind === 'card') drawCardPoster(ctx, o, attempt)
    else drawStatPoster(ctx, o, attempt)
    try {
      ctx.getImageData(0, 0, 1, 1) // throws on a tainted canvas: draw again without the image
      return canvas
    } catch {
      // try again with the card back
    }
  }
  return null
}

/** The picture as a PNG Blob, or null. */
export async function renderPicture(kind, o, options) {
  const canvas = await drawPicture(kind, o, options)
  return canvas ? toBlob(canvas) : null
}

