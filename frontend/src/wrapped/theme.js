// The look of Wrapped v2 (engagement P9c, docs/WRAPPED_REDESIGN.md §3), taken from the Wave 2b mockups.
// Inside Wrapped these colours win over the app's own tokens (TYPE_COLOURS) where the two differ.
// Everything here is plain data, shared by the slides (DOM) and the share pictures (Canvas 2D).

export const STAGE_W = 390
export const STAGE_H = 844

export const DISPLAY_FONT = '"Archivo Wrapped", -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif'
export const TEXT_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif'
export const DARK_INK = '#1D1600'

// Foil gradients (§3.3), as CSS and as stops for the canvas.
export const FOIL_FRAME = 'linear-gradient(135deg, #FFF6C8, #FF9BD2 28%, #9BE7FF 52%, #B4F5A8 74%, #FFF6C8)'
export const FOIL_FRAME_STOPS = [[0, '#FFF6C8'], [0.28, '#FF9BD2'], [0.52, '#9BE7FF'], [0.74, '#B4F5A8'], [1, '#FFF6C8']]
export const FOIL_SMALL = 'linear-gradient(135deg, #FFF6C8, #FF9BD2, #9BE7FF, #FFF6C8)'
export const FOIL_SMALL_STOPS = [[0, '#FFF6C8'], [1 / 3, '#FF9BD2'], [2 / 3, '#9BE7FF'], [1, '#FFF6C8']]
export const FOIL_COIN = 'linear-gradient(135deg, #FFE56E, #FF9BD2, #9BE7FF)'
export const FOIL_COIN_STOPS = [[0, '#FFE56E'], [0.5, '#FF9BD2'], [1, '#9BE7FF']]

/**
 * One entry per energy type. `bg` is the slide gradient (160°), `solid` the coin colour, `glow` the
 * light behind the hero, `light` the foil tint of big numbers and rings, `soft` secondary text,
 * `coin` the inside of the big energy coin, `night` the summary background (radial, three stops),
 * `deep` the far end of share picture A, `face` the trainer card face, `ink` the text colour.
 * Psychic, fire, grass, water, lightning, darkness and colorless are the mockups' values.
 */
export const WRAP_TYPES = {
  grass: {
    bg: ['#2E7A34', '#145A27'], solid: '#43B04A', glow: 'rgba(67,176,74,0.55)', light: '#D4F5C8', soft: '#E8F5E9',
    coin: ['#22602A', '#0E3F1B'], night: ['#163A1C', '#0A1C0E', '#050E07'], deep: '#0B2A12', ink: '#FFFFFF',
  },
  fire: {
    bg: ['#B4441F', '#8A1D12'], solid: '#F05A2B', glow: 'rgba(240,90,43,0.45)', light: '#FFE7B8', soft: '#FFE5DC',
    coin: ['#8E2A12', '#5A1208'], night: ['#3D160C', '#1E0A05', '#0E0502'], deep: '#2E0C05', ink: '#FFFFFF',
  },
  water: {
    bg: ['#236BB4', '#0F3478'], solid: '#2F8FF0', glow: 'rgba(47,143,240,0.6)', light: '#C9F1FF', soft: '#DCEBFF',
    coin: ['#1A5FB0', '#0C2C66'], night: ['#142C4E', '#0A1626', '#050B13'], deep: '#081E40', ink: '#FFFFFF',
  },
  lightning: {
    bg: ['#FFE56E', '#F2A600'], solid: '#F7C815', glow: 'rgba(255,255,255,0.75)', light: '#FFF6C8', soft: '#3A2E00',
    coin: ['#F7C815', '#C98A00'], night: ['#3A3210', '#1C1806', '#0E0C03'], deep: '#B37A00', ink: DARK_INK,
  },
  psychic: {
    bg: ['#8A3BA5', '#4A1868'], solid: '#B84FDC', glow: 'rgba(184,79,220,0.6)', light: '#F7D6FF', soft: '#F3E3FA',
    coin: ['#6E2A8E', '#3E1257'], night: ['#3A1752', '#1A0A28', '#0C0614'], deep: '#240A35', ink: '#FFFFFF',
  },
  fighting: {
    bg: ['#995023', '#6A2D0E'], solid: '#CC6A2F', glow: 'rgba(204,106,47,0.55)', light: '#FFD9C2', soft: '#FBE6D9',
    coin: ['#7E3A15', '#4E1F08'], night: ['#3A2012', '#1C0E07', '#0D0603'], deep: '#2E1406', ink: '#FFFFFF',
  },
  darkness: {
    bg: ['#343F50', '#141A24'], solid: '#46546A', glow: 'rgba(255,203,5,0.3)', light: '#D1D5DB', soft: '#D1D5DB',
    coin: ['#2A3342', '#10151D'], night: ['#232A35', '#11151B', '#08090C'], deep: '#0A0D12', ink: '#FFFFFF',
  },
  metal: {
    bg: ['#606972', '#3E4852'], solid: '#94A2B0', glow: 'rgba(148,162,176,0.55)', light: '#E3EAF0', soft: '#E6EBF0',
    coin: ['#4C545C', '#2C333A'], night: ['#2A3036', '#14181C', '#090B0D'], deep: '#1C2228', ink: '#FFFFFF',
  },
  dragon: {
    bg: ['#836919', '#5A4207'], solid: '#C9A227', glow: 'rgba(201,162,39,0.55)', light: '#FFEBA8', soft: '#F6EBCB',
    coin: ['#6A5412', '#3F2E04'], night: ['#3A2F0E', '#1B1505', '#0D0A02'], deep: '#2A1F03', ink: '#FFFFFF',
  },
  fairy: {
    bg: ['#B35383', '#86244F'], solid: '#EF6FAE', glow: 'rgba(239,111,174,0.55)', light: '#FFD6EA', soft: '#FBE1EE',
    coin: ['#93406A', '#5E1836'], night: ['#3D1729', '#1E0A14', '#0E050A'], deep: '#3A0F22', ink: '#FFFFFF',
  },
  colorless: {
    bg: ['#F5F1E6', '#CFC6AF'], solid: '#E3DCCB', glow: 'rgba(255,255,255,0.6)', light: '#FFFFFF', soft: '#3A3220',
    coin: ['#E3DCCB', '#BDB39B'], night: ['#33302A', '#17150F', '#0B0A07'], deep: '#4A4434', ink: DARK_INK,
  },
}

export const paletteFor = key => WRAP_TYPES[key] || WRAP_TYPES.colorless
export const isLight = key => paletteFor(key).ink === DARK_INK

// Original 24-grid glyphs (§3.2). `fill` paths are filled, `stroke` paths are drawn with `width`.
export const SPARKLE = 'M12 2c.8 5.2 4.8 9.2 10 10-5.2.8-9.2 4.8-10 10-.8-5.2-4.8-9.2-10-10 5.2-.8 9.2-4.8 10-10z'
export const FLAME = 'M12 2c1 4 6 6.5 6 12a6 6 0 0 1-12 0c0-3 1.8-5 3-6 0 2 1 3.2 2.2 3.2C11.2 7.4 10 5 12 2z'
export const DROP = 'M12 3s7 7.5 7 12a7 7 0 0 1-14 0c0-4.5 7-12 7-12z'
export const BOLT = 'M13 2 4 14h7l-1 8 9-12h-7z'
export const HEX = 'M12 2 21 7v10l-9 5-9-5V7z'
export const SHIELD = 'M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z'
export const CHECK = 'M5 12.5l4.5 4.5L19 7.5'
export const SHARE = 'M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6'
export const EYE = 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z'

export const GLYPHS = {
  grass: { stroke: ['M5 19c0-9 6-14 15-14 0 9-5 15-14 15M5 19l8-8'], width: 2.6 },
  fire: { fill: [FLAME] },
  water: { fill: [DROP] },
  lightning: { fill: [BOLT] },
  psychic: { stroke: [EYE], circles: [[12, 12, 3]], width: 2.4 },
  fighting: {
    stroke: ['M7 11V8a2 2 0 0 1 4 0v3M11 10V7a2 2 0 0 1 4 0v4M15 10.5V9a2 2 0 0 1 4 0v4.5a7 7 0 0 1-7 7h-.5A6.5 6.5 0 0 1 5 14v-1.5a2 2 0 0 1 2-2h4.5'],
    width: 2.2,
  },
  darkness: { fill: ['M15.5 3a9 9 0 1 0 5.5 15.6A7.6 7.6 0 0 1 15.5 3z'] },
  metal: { fill: ['M12 2 21 7v10l-9 5-9-5V7zm0 6.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z'], evenOdd: true },
  dragon: { fill: ['M5 3c4.5 2.2 9.5 2.2 14 0-1.2 7.4-3.4 13.2-7 18.5C8.4 16.2 6.2 10.4 5 3z'] },
  fairy: { fill: [SPARKLE] },
  colorless: { circles: [[12, 12, 7]], width: 2.6, ring: true },
}

/** Trainer type (persona) from the top type (§3.5): needs at least 10 cards in the year. Names are i18n. */
export const PERSONA_MIN_CARDS = 10

/** Rarity mark from the year's card count (§3.6). Returns the i18n key and the mark. */
export function rarityFor(cards) {
  const n = Number(cards) || 0
  if (n >= 2000) return { key: 'ultraRare', mark: '★★★' }
  if (n >= 750) return { key: 'doubleRare', mark: '★★' }
  if (n >= 200) return { key: 'rare', mark: '★' }
  if (n >= 50) return { key: 'uncommon', mark: '◆' }
  return { key: 'common', mark: '●' }
}

// Badge medallion tints, in the mockup's order (§3.7).
export const BADGE_TINTS = ['#F05A2B', '#2F8FF0', '#43B04A', '#F7C815', '#B84FDC', '#CC6A2F', '#94A2B0', '#C9A227', '#EF6FAE']
