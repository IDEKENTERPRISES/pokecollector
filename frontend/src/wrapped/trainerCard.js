// The trainer card (Wrapped summary, docs/WRAPPED_REDESIGN.md §4 slide 010 and share picture A).
// `trainerCardModel` says what the card shows; `trainerCardLayout` places every piece in card units
// (356 × 498, after W2bSummary / W2bThinData). The slide renders the layout as absolutely placed
// elements and the share picture draws the same layout on a canvas, so the two cannot drift apart.
// Text is measured with one canvas measurer for both, so line breaks and ellipses agree too.
import { fill } from '../delights/delights'
import { DARK_INK, DISPLAY_FONT, TEXT_FONT, paletteFor } from './theme'
import { dayMonth, personaKey, rarityOf, thousands } from './wrapped'

export const CARD_W = 356
export const CARD_H = 498
const X0 = 20
const X1 = 336
const FOOTER_Y = 454

let measureCtx
/** Width of `text` in px for a { size, weight, display } font. Falls back to an estimate without canvas. */
export function measureText(text, font) {
  if (measureCtx === undefined) {
    try {
      measureCtx = globalThis.document?.createElement('canvas').getContext('2d') || null
    } catch {
      measureCtx = null
    }
  }
  if (!measureCtx) return String(text).length * font.size * (font.display ? 0.45 : 0.56)
  measureCtx.font = cssFont(font)
  const spacing = (font.spacing || 0) * Math.max(0, String(text).length)
  return measureCtx.measureText(String(text)).width + spacing
}

export const cssFont = ({ size, weight, display }) => `${weight} ${size}px ${display ? DISPLAY_FONT : TEXT_FONT}`

/** `text` cut with an ellipsis to fit `width`. */
export function fitText(text, font, width) {
  const value = String(text ?? '')
  if (measureText(value, font) <= width) return value
  let end = value.length
  while (end > 1 && measureText(`${value.slice(0, end).trimEnd()}…`, font) > width) end -= 1
  return `${value.slice(0, end).trimEnd()}…`
}

/** Up to `max` lines of `text` within `width`, the last one ellipsised. */
export function wrapText(text, font, width, max = 2) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (let i = 0; i < words.length; i += 1) {
    const next = line ? `${line} ${words[i]}` : words[i]
    if (measureText(next, font) <= width || !line) {
      line = next
      continue
    }
    if (lines.length === max - 1) {
      line = `${line} ${words.slice(i).join(' ')}`
      break
    }
    lines.push(line)
    line = words[i]
  }
  if (line) lines.push(line)
  return lines.map((l, i) => (i === lines.length - 1 ? fitText(l, font, width) : l))
}

/**
 * What the card says. `footer` is the right-hand footer text ("PokéCollector · 010/010" on the
 * slide, "PokéCollector · 2026" in the picture). `money` already masks while hide-values is on.
 */
export function trainerCardModel({ data, t, name, locale, money, showDaily = true, footer }) {
  const persona = personaKey(data)
  const key = persona || 'colorless'
  const totals = data.totals || {}
  const pull = data.best_pull
  const first = data.first_card
  const stats = [
    totals.cards > 0 && { label: t('wrapped.cardsAdded'), value: thousands(totals.cards, locale) },
    totals.sets_completed > 0 && { label: t('wrapped.setsCompleted'), value: thousands(totals.sets_completed, locale) },
    data.top_pokemon && { label: t('wrapped.pokemonOfTheYear'), value: data.top_pokemon.name },
    showDaily && data.longest_streak > 0 && {
      label: t('wrapped.longestStreakTitle'),
      value: fill(t(data.longest_streak === 1 ? 'wrapped.dayOne' : 'wrapped.days'), { count: thousands(data.longest_streak, locale) }),
    },
  ].filter(Boolean)
  let art = { kind: 'mark' }
  if (pull) {
    art = { kind: 'card', label: t('wrapped.topPullShort'), name: pull.name, image: pull.image, price: pull.price > 0 ? money(pull.price) : null }
  } else if (first) {
    art = { kind: 'card', label: t('wrapped.firstCardShort'), name: first.name, image: first.image, price: null }
  }
  const rarity = rarityOf(data)
  return {
    key,
    palette: paletteFor(key),
    light: paletteFor(key).ink === DARK_INK,
    year: data.year,
    label: fill(t('wrapped.trainerLabel'), { year: data.year }),
    name: name || t('wrapped.trainer'),
    persona: persona ? t(`wrapped.personas.${persona}`) : t('wrapped.trainer'),
    since: data.partial_history && data.history_starts && stats.length <= 2
      ? fill(t('wrapped.collectedSince'), { date: dayMonth(data.history_starts, locale) })
      : null,
    art,
    stats,
    rarity: `${rarity.mark} ${t(`wrapped.rarity.${rarity.key}`)}`,
    footer: footer || '',
  }
}

/** The accessible description of the card (and the share picture's alt text without amounts). */
export function trainerCardLabel(model, t, { withAmounts = true } = {}) {
  const parts = [fill(t('wrapped.cardLabel'), { name: model.name, year: model.year }), model.persona]
  if (model.since) parts.push(model.since)
  if (model.art.kind === 'card') {
    const price = withAmounts && model.art.price && !model.art.price.includes('•') ? `, ${model.art.price}` : ''
    parts.push(`${model.art.label} ${model.art.name}${price}`)
  }
  model.stats.forEach(stat => parts.push(`${stat.label} ${stat.value}`))
  parts.push(model.rarity)
  return `${parts.join('. ')}.`
}

// Fonts of the card, in card units.
export const CARD_FONTS = {
  label: { size: 11, weight: 800, spacing: 1.6 },
  name: { size: 44, weight: 900, display: true },
  persona: { size: 16, weight: 800 },
  chip: { size: 13, weight: 700 },
  artLabel: { size: 13, weight: 600 },
  artLabelThin: { size: 13, weight: 700 },
  artName: { size: 22, weight: 800 },
  artNameBig: { size: 24, weight: 800 },
  price: { size: 34, weight: 900, display: true },
  dt: { size: 13, weight: 600 },
  dtThin: { size: 13, weight: 700 },
  dd: { size: 32, weight: 900, display: true },
  rarity: { size: 14, weight: 800 },
  footer: { size: 12, weight: 700 },
}

/**
 * Every box of the card in card units. Text items are { text, x, y (top of the line box), lh
 * (line height), font, align }. Follows the mockups' flex layout: 14 px padding, 12 px gaps, the
 * art window 178 high with 3–4 stats (two grid rows), or growing into the free space with 1–2.
 */
export function trainerCardLayout(model) {
  const F = CARD_FONTS
  const persona = { text: model.persona, x: 288, y: 40 - 10, lh: 20, font: F.persona, align: 'right' }
  const personaWidth = measureText(model.persona, F.persona)
  const nameWidth = Math.max(60, 288 - personaWidth - 12 - X0)
  const header = {
    label: { text: model.label, x: X0, y: 20, lh: 13, font: F.label },
    name: { text: fitText(model.name, F.name, nameWidth), x: X0, y: 35, lh: 42, font: F.name },
    persona,
    coin: { x: 296, y: 20, size: 40 },
  }
  let y = 20 + 57 + 12
  let chip = null
  if (model.since) {
    const width = Math.min(316, measureText(model.since, F.chip) + 23)
    chip = { x: X0, y: y - 4, w: width, h: 27, text: { text: model.since, x: X0 + 11.5, y: y - 4 + 5.5, lh: 16, font: F.chip } }
    y = chip.y + chip.h + 12
  }
  const grid = model.stats.length > 2 ? 2 : 1
  const rowsH = grid * 49 + (grid - 1) * 10
  let art
  let statsTop
  if (grid === 2) {
    art = { x: X0, y, w: 316, h: 178 }
    const region = { top: art.y + art.h + 12, bottom: FOOTER_Y - 12 }
    statsTop = region.top + Math.max(0, (region.bottom - region.top - rowsH) / 2)
  } else {
    statsTop = FOOTER_Y - 12 - rowsH
    art = { x: X0, y, w: 316, h: Math.max(178, statsTop - 12 - y) }
  }
  const big = art.h >= 220
  const pad = big ? 18 : 16
  const mini = big ? { w: 118, h: 165, rot: -5 } : { w: 96, h: 134, rot: -6 }
  mini.x = art.x + 3 + pad
  mini.y = art.y + (art.h - mini.h) / 2
  const artItems = []
  let mark = null
  if (model.art.kind === 'card') {
    const textX = mini.x + mini.w + pad
    const width = art.x + art.w - 3 - pad - textX
    const nameFont = big ? F.artNameBig : F.artName
    const nameLh = Math.round(nameFont.size * 1.1)
    const names = wrapText(model.art.name, nameFont, width, 2)
    const blockH = 16 + 2 + names.length * nameLh + (model.art.price ? 4 + 34 : 0)
    let ty = art.y + (art.h - blockH) / 2
    artItems.push({ role: 'label', text: model.art.label, x: textX, y: ty, lh: 16, font: model.light ? F.artLabelThin : F.artLabel })
    ty += 18
    names.forEach(text => {
      artItems.push({ role: 'name', text, x: textX, y: ty, lh: nameLh, font: nameFont })
      ty += nameLh
    })
    if (model.art.price) artItems.push({ role: 'price', text: fitText(model.art.price, F.price, width), x: textX, y: ty + 4, lh: 34, font: F.price })
  } else {
    mark = { x: art.x + art.w / 2 - 46, y: art.y + art.h / 2 - 46, size: 92 }
  }
  const colW = (316 - 12) / 2
  const stats = model.stats.map((stat, i) => {
    const x = X0 + (i % 2) * (colW + 12)
    const top = statsTop + Math.floor(i / 2) * 59
    return {
      dt: { text: fitText(stat.label, F.dt, colW), x, y: top, lh: 16, font: model.light ? F.dtThin : F.dt },
      dd: { text: fitText(stat.value, F.dd, colW), x, y: top + 17, lh: 32, font: F.dd },
    }
  })
  return {
    header,
    chip,
    art,
    mini: model.art.kind === 'card' ? mini : null,
    artItems,
    mark,
    sparkle: model.light ? null : { x: art.x + art.w - 3 - 12 - 16, y: art.y + 3 + 10, size: 16 },
    stats,
    footer: {
      y: FOOTER_Y,
      rarity: { text: model.rarity, x: X0, y: FOOTER_Y + 9, lh: 17, font: F.rarity },
      right: { text: model.footer, x: X1, y: FOOTER_Y + 9 + 1.5, lh: 14, font: F.footer, align: 'right' },
    },
  }
}

/** Colours of the card for its palette (dark face, or the light colorless / lightning face). */
export function cardColours(model) {
  const p = model.palette
  if (model.light) {
    return {
      face: model.key === 'colorless' ? ['#F5F1E6', '#CFC6AF'] : p.bg,
      ink: DARK_INK, label: '#4A4030', soft: '#3A3220', texture: 'rgba(255,255,255,0.25)',
      artBorder: 'rgba(29,22,0,0.35)', artGlow: 'rgba(255,255,255,0.6)', artBg: ['#D9D0B8', '#A99E82'],
      artLabel: '#3A3220', price: DARK_INK, rarity: DARK_INK, rule: 'rgba(29,22,0,0.3)',
      coin: p.solid, coinBorder: '#8C826A', glyph: DARK_INK, chipBorder: 'rgba(29,22,0,0.5)',
    }
  }
  return {
    face: p.bg, ink: '#FFFFFF', label: p.soft, soft: p.soft, texture: 'rgba(255,255,255,0.06)',
    artBorder: 'rgba(255,246,200,0.85)', artGlow: 'rgba(255,203,5,0.25)', artBg: ['#262C55', '#0B0E1E'],
    artLabel: '#D1D5F0', price: '#FFCB05', rarity: '#FFE56E', rule: 'rgba(255,255,255,0.3)',
    coin: p.solid, coinBorder: p.light, glyph: '#FFFFFF', chipBorder: 'rgba(255,255,255,0.6)',
  }
}
