import { normalizePrintingDetailName } from '../../utils/printingDetails'

// Ids must match backend/services/foil_patterns.py (FOIL_PATTERNS).
export const FOIL_PATTERN_IDS = [
  'holo',
  'reverse',
  'cracked-ice',
  'cosmos',
  'etched',
  'rainbow',
  'gold',
  'pokeball-reverse',
  'radiant',
  'amazing',
  'v-full-art',
  'vmax',
  'vstar',
  'trainer-gallery',
  'shiny',
  'illustration-rare',
  'special-illustration',
]

// Small gradient chips for the picker (decoration only).
export const FOIL_SWATCHES = {
  holo: 'linear-gradient(115deg,#7a5cff,#2fd0ff,#5cff9a,#ffe45c,#ff6a5c)',
  reverse: 'linear-gradient(135deg,#e8f3ff,#8aa4c8 45%,#f5fbff)',
  'cracked-ice': 'linear-gradient(120deg,#cfeeff,#6bb7e8 40%,#f4fcff 55%,#7fc4ee)',
  cosmos: 'radial-gradient(circle at 30% 30%,#ff9ad5,#6b4bd8 45%,#141a4a)',
  etched: 'repeating-linear-gradient(45deg,#d9c9a3 0 3px,#8b7a52 3px 6px)',
  rainbow: 'linear-gradient(90deg,#ff5c5c,#ffb25c,#fff05c,#5cff8a,#5cc8ff,#9a5cff)',
  gold: 'linear-gradient(135deg,#fff3b0,#e0a800 50%,#fff0a0)',
  'pokeball-reverse': 'radial-gradient(circle at 50% 50%,#fff 0 12%,#222 12% 16%,#e3350d 16% 48%,#f5f5f5 48%)',
  radiant: 'linear-gradient(135deg,#ffd0f0,#a8f0ff,#fff3a8,#d6b8ff)',
  amazing: 'conic-gradient(from 0deg,#ff5c8a,#ffd45c,#5cffb0,#5cb8ff,#b05cff,#ff5c8a)',
  'v-full-art': 'linear-gradient(160deg,#5cd0ff,#7a5cff 50%,#ff8ad8)',
  vmax: 'linear-gradient(160deg,#2b2f7a,#7a3cff 55%,#ff5cae)',
  vstar: 'linear-gradient(160deg,#fff3b0,#ffb84d 50%,#d98cff)',
  'trainer-gallery': 'linear-gradient(135deg,#c8e8ff,#fff 40%,#ffd9a8)',
  shiny: 'linear-gradient(135deg,#bfe9ff,#fff6c8 50%,#ffc8f4)',
  'illustration-rare': 'repeating-linear-gradient(135deg,#ffe9b8 0 4px,#d9a85c 4px 8px)',
  'special-illustration': 'repeating-linear-gradient(135deg,#ffe9b8 0 4px,#d9a85c 4px 8px), radial-gradient(circle,#fff,#0000)',
}

// Names a printing-detail tag may use for a pattern (compared after normalizePrintingDetailName).
const TAG_ALIASES = {
  holo: ['holo', 'holofoil', 'holographic'],
  reverse: ['reverse', 'reverse holo', 'reverse holofoil'],
  'cracked-ice': ['cracked ice', 'crackedice', 'cracked ice holo'],
  cosmos: ['cosmos', 'cosmos holo'],
  etched: ['etched', 'textured', 'texture', 'etched holo'],
  rainbow: ['rainbow', 'rainbow rare'],
  gold: ['gold', 'golden', 'gold rare'],
  'pokeball-reverse': ['poke ball', 'pokeball', 'poke ball reverse', 'pokeball reverse', 'poke ball pattern'],
  radiant: ['radiant', 'radiant holo'],
  amazing: ['amazing', 'amazing rare'],
  'v-full-art': ['v full art', 'full art', 'fullart'],
  vmax: ['vmax'],
  vstar: ['vstar', 'v star'],
  'trainer-gallery': ['trainer gallery'],
  shiny: ['shiny', 'shiny rare'],
  'illustration-rare': ['illustration rare', 'illustration'],
  'special-illustration': ['special illustration', 'special illustration rare'],
}

const TAG_LOOKUP = new Map(
  Object.entries(TAG_ALIASES).flatMap(([id, names]) => names.map(name => [normalizePrintingDetailName(name), id])),
)

export const isFoilPattern = id => FOIL_PATTERN_IDS.includes(id)

export function foilPatternFromTag(name) {
  return TAG_LOOKUP.get(normalizePrintingDetailName(name)) || null
}

/** The first printing-detail tag (name string or {name}) that names a pattern, as { pattern, name }. */
export function foilPatternFromTags(details) {
  for (const detail of details || []) {
    const name = typeof detail === 'string' ? detail : detail?.name
    const pattern = foilPatternFromTag(name)
    if (pattern) return { pattern, name }
  }
  return null
}
