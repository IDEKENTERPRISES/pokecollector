import { foilPatternFromTags, isFoilPattern } from './foilPatterns'

const norm = value => String(value || '')
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .toLowerCase()
  .replace(/[^\p{Letter}\p{Number}.]+/gu, ' ')
  .trim()

function toSubtypes(value) {
  const list = Array.isArray(value) ? value : (value ? [value] : [])
  return list.map(norm).filter(Boolean)
}

export function foilContext(rawCard, variant = '') {
  const card = rawCard || {}
  const variantName = norm(typeof variant === 'string' ? variant : variant?.variant)
  const number = String(card.number || card.local_id || '').toUpperCase()
  return {
    rarity: norm(card.rarity),
    subtypes: toSubtypes(card.subtypes),
    supertype: norm(card.supertype),
    stage: norm(card.stage),
    setId: String(card.set_id || card.setId || '').toLowerCase(),
    number,
    name: norm(card.name),
    variant: variantName,
    isReverse: variantName.includes('reverse'),
    isHolo: variantName === 'holo' || variantName.includes('holo'),
  }
}

const hasSubtype = (ctx, ...names) => names.some(name => ctx.subtypes.includes(name))
const isTrainer = ctx => ctx.supertype === 'trainer'

// Trainer Gallery (Sword & Shield) and Galarian Gallery numbers: TG01 / GG01. TCGdex also files
// them under their own set ids ("swsh9tg", "swsh12.5gg").
const GALLERY_NUMBER = /^(TG|GG)\d+/
const GALLERY_SET = /(tg|gg)$/
// McDonald's Collection promo sets: cracked-ice holo in the real cards.
const MCDONALDS_SET = /^(2011bw|2012bw|2014xy|2015xy|2016xy|2017sm|2018sm|2019sm|2021swsh|2022swsh|2023sv)$/
// Scarlet & Violet sets whose reverse holos carry the Poké Ball pattern.
const POKEBALL_REVERSE_SET = /^sv0?(1|2|3|3\.5|4)$/
// Black Star promo sets; their holos carry the cosmos pattern.
const COSMOS_PROMO_SET = /^(swshp|smp|xyp|bwp|svp)$/

/**
 * Ordered rules, first match wins. Each rule: { id, pattern, test(ctx) }.
 * Rarity strings are TCGdex's, matched case-insensitively ("Special illustration rare",
 * "Rare Holo VMAX", "Double rare", ...). The order matters: the most specific printings first,
 * the variant-driven fallbacks last.
 */
export const FOIL_RULES = [
  { id: 'special-illustration', pattern: 'special-illustration', test: c => c.rarity.includes('special illustration') },
  { id: 'illustration-rare', pattern: 'illustration-rare', test: c => c.rarity.includes('illustration') },
  { id: 'trainer-gallery', pattern: 'trainer-gallery', test: c => GALLERY_NUMBER.test(c.number) || GALLERY_SET.test(c.setId) },
  { id: 'amazing', pattern: 'amazing', test: c => c.rarity.includes('amazing') },
  { id: 'radiant', pattern: 'radiant', test: c => c.rarity.includes('radiant') },
  { id: 'shiny', pattern: 'shiny', test: c => c.rarity.includes('shiny') },
  { id: 'gold-hyper', pattern: 'gold', test: c => c.rarity.includes('hyper') || c.rarity === 'rare secret' || c.rarity.includes('gold') },
  { id: 'rainbow', pattern: 'rainbow', test: c => c.rarity.includes('rainbow') || c.rarity.includes('secret') || c.rarity.includes('black white') },
  { id: 'vmax', pattern: 'vmax', test: c => hasSubtype(c, 'vmax') || c.rarity.includes('vmax') || c.rarity.includes('v max') },
  { id: 'vstar', pattern: 'vstar', test: c => hasSubtype(c, 'vstar') || c.rarity.includes('vstar') || c.rarity.includes('v star') },
  { id: 'etched-trainer', pattern: 'etched', test: c => isTrainer(c) && (c.rarity.includes('ultra') || c.rarity.includes('full art')) },
  {
    id: 'v-full-art',
    pattern: 'v-full-art',
    test: c => c.rarity.includes('ultra') || c.rarity.includes('double rare') || c.rarity.includes('full art')
      || hasSubtype(c, 'v', 'v union') || hasSubtype(c, 'ex', 'gx') && c.rarity.includes('ultra'),
  },
  { id: 'cracked-ice', pattern: 'cracked-ice', test: c => MCDONALDS_SET.test(c.setId) && (c.isHolo || c.rarity.includes('holo')) },
  { id: 'cosmos-promo', pattern: 'cosmos', test: c => COSMOS_PROMO_SET.test(c.setId) && c.rarity.includes('promo') && !c.isReverse },
  { id: 'pokeball-reverse', pattern: 'pokeball-reverse', test: c => c.isReverse && POKEBALL_REVERSE_SET.test(c.setId) },
  { id: 'reverse', pattern: 'reverse', test: c => c.isReverse },
  { id: 'holo-rarity', pattern: 'holo', test: c => c.rarity.startsWith('rare holo') || c.rarity === 'holo rare' || c.rarity === 'rare ace' },
  { id: 'holo-variant', pattern: 'holo', test: c => c.isHolo },
]

/** The automatic pattern for a card and variant: an id, or null when it has no foil. */
export function autoFoilPattern(card, variant) {
  const ctx = foilContext(card, variant)
  const rule = FOIL_RULES.find(entry => entry.test(ctx))
  return rule ? rule.pattern : null
}

/**
 * Pattern for one copy, strongest first: the copy's own foil_pattern, a printing-detail tag that
 * names a pattern, then the rules.
 * Returns { pattern, source: 'copy' | 'tag' | 'rules' | 'none', tagName, auto }, where `auto`
 * is what Automatic would give (rules only, ignoring the copy's choice but not its tag).
 */
export function resolveFoilPattern({ card, variant, printingDetails, foilPattern } = {}) {
  const rules = autoFoilPattern(card, variant)
  const tag = foilPatternFromTags(printingDetails)
  const auto = tag ? tag.pattern : rules
  if (foilPattern && isFoilPattern(foilPattern)) {
    return { pattern: foilPattern, source: 'copy', tagName: tag?.name || null, auto, rules }
  }
  if (tag) return { pattern: tag.pattern, source: 'tag', tagName: tag.name, auto, rules }
  return { pattern: rules, source: rules ? 'rules' : 'none', tagName: null, auto, rules }
}
