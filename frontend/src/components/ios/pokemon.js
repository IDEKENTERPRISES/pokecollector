// The Pokémon layer's data (design doc §7.12): the eleven energy-type colours, the brand triad,
// colourFor() and the pure helpers the components and their tests share.
// The same hex values live in :root of src/index.css as --type-<name>-top/-bottom/-name;
// pokemon.test.js checks that the two copies agree.

export const TYPE_KEYS = [
  'grass', 'fire', 'water', 'lightning', 'psychic', 'fighting',
  'darkness', 'metal', 'dragon', 'fairy', 'colorless',
]

const DARK_TEXT = '#1D1600'

// top / bottom: the tile gradient stops. solid: chips, icons and glows. text: tile text colour,
// which must reach 4.5:1 on both stops (checked by a unit test).
export const TYPE_COLOURS = {
  grass:     { top: '#328438', bottom: '#145A27', solid: '#43B04A', text: '#FFFFFF' },
  fire:      { top: '#B4441F', bottom: '#8A1D12', solid: '#F05A2B', text: '#FFFFFF' },
  water:     { top: '#236BB4', bottom: '#123F8C', solid: '#2F8FF0', text: '#FFFFFF' },
  lightning: { top: '#FFE56E', bottom: '#F2A600', solid: '#F7C815', text: DARK_TEXT },
  psychic:   { top: '#8A3BA5', bottom: '#551C78', solid: '#B84FDC', text: '#FFFFFF' },
  fighting:  { top: '#995023', bottom: '#6A2D0E', solid: '#CC6A2F', text: '#FFFFFF' },
  darkness:  { top: '#343F50', bottom: '#141A24', solid: '#46546A', text: '#FFFFFF' },
  metal:     { top: '#606972', bottom: '#3E4852', solid: '#94A2B0', text: '#FFFFFF' },
  dragon:    { top: '#836919', bottom: '#5A4207', solid: '#C9A227', text: '#FFFFFF' },
  fairy:     { top: '#B35383', bottom: '#86244F', solid: '#EF6FAE', text: '#FFFFFF' },
  colorless: { top: '#F5F1E6', bottom: '#BDB39B', solid: '#E3DCCB', text: DARK_TEXT },
}

export const BRAND = { red: '#E3350D', yellow: '#FFCB05', blue: '#2A75BB' }

// Names the API and the card data use for each type, in any case.
const TYPE_ALIASES = {
  electric: 'lightning',
  lightning: 'lightning',
  dark: 'darkness',
  darkness: 'darkness',
  steel: 'metal',
  metal: 'metal',
  normal: 'colorless',
  colourless: 'colorless',
  colorless: 'colorless',
}

/** Normalise a type name ("Lightning", "Electric", "Colorless") to one of TYPE_KEYS, else null. */
export function typeKeyFor(type) {
  if (typeof type !== 'string') return null
  const key = type.trim().toLowerCase()
  if (TYPE_KEYS.includes(key)) return key
  return TYPE_ALIASES[key] ?? null
}

/** The CSS variable for part of a type's palette: 'top' | 'bottom' | 'solid' (default). */
export function typeVar(type, part = 'solid') {
  const key = typeKeyFor(type) ?? 'colorless'
  return part === 'solid' ? `var(--type-${key})` : `var(--type-${key}-${part})`
}

/** Tile text colour for a type. */
export function tileTextFor(type) {
  return TYPE_COLOURS[typeKeyFor(type) ?? 'colorless'].text
}

/**
 * Map a set or series key to one of the eleven types with a stable hash (FNV-1a), for banners
 * and glows that have no colour of their own. The same key always gives the same type.
 */
export function colourFor(key) {
  const text = String(key ?? '')
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return TYPE_KEYS[hash % TYPE_KEYS.length]
}

// ── Contrast (WCAG 2.x relative luminance) ──────────────────────────────────

function channel(value) {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(hex) {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16)
  const g = parseInt(clean.slice(2, 4), 16)
  const b = parseInt(clean.slice(4, 6), 16)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export function contrastRatio(a, b) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

// ── HP bar ───────────────────────────────────────────────────────────────────

/** Completion as a 0..1 fraction, safe for max = 0 and out-of-range values. */
export function hpFraction(value, max) {
  const v = Number(value)
  const m = Number(max)
  if (!Number.isFinite(v) || !Number.isFinite(m) || m <= 0) return 0
  return Math.min(1, Math.max(0, v / m))
}

/** Green above 50 %, yellow from 20 % to 50 %, red below 20 %, like a Pokémon's HP. */
export function hpTone(value, max) {
  const fraction = hpFraction(value, max)
  if (fraction > 0.5) return 'green'
  if (fraction >= 0.2) return 'yellow'
  return 'red'
}
