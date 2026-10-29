import { describe, expect, it } from 'vitest'
import { autoFoilPattern, resolveFoilPattern, FOIL_RULES } from './foilRules'
import { FOIL_PATTERN_IDS, foilPatternFromTag, foilPatternFromTags } from './foilPatterns'

const card = (extra = {}) => ({ name: 'Test', supertype: 'Pokémon', subtypes: ['Basic'], set_id: 'sv01', number: '1', ...extra })

describe('autoFoilPattern (TCGdex rarity strings)', () => {
  it.each([
    ['Special illustration rare', 'special-illustration'],
    ['Illustration rare', 'illustration-rare'],
    ['Hyper rare', 'gold'],
    ['Mega Hyper Rare', 'gold'],
    ['Secret Rare', 'rainbow'],
    ['Rare Rainbow', 'rainbow'],
    ['Amazing Rare', 'amazing'],
    ['Radiant Rare', 'radiant'],
    ['Shiny rare', 'shiny'],
    ['Shiny rare V', 'shiny'],
    ['Double rare', 'v-full-art'],
    ['Ultra Rare', 'v-full-art'],
    ['Rare Ultra', 'v-full-art'],
    ['Rare Holo', 'holo'],
    ['Rare Holo EX', 'holo'],
    ['Rare Holo GX', 'holo'],
  ])('%s -> %s', (rarity, expected) => {
    expect(autoFoilPattern(card({ rarity }), 'Normal')).toBe(expected)
  })

  it('uses subtypes for V-series cards', () => {
    expect(autoFoilPattern(card({ rarity: 'Rare Holo VMAX', subtypes: ['VMAX'] }), 'Holo')).toBe('vmax')
    expect(autoFoilPattern(card({ rarity: 'Ultra Rare', subtypes: ['VSTAR'] }), 'Holo')).toBe('vstar')
    expect(autoFoilPattern(card({ rarity: 'Rare Holo V', subtypes: ['V'] }), 'Holo')).toBe('v-full-art')
  })

  it('gives textured full-art trainers the etched look', () => {
    expect(autoFoilPattern(card({ supertype: 'Trainer', rarity: 'Ultra Rare', subtypes: ['Supporter'] }), 'Holo')).toBe('etched')
  })

  it('detects the Trainer Gallery by number or set id', () => {
    expect(autoFoilPattern(card({ number: 'TG05', rarity: 'Rare Holo V' }), 'Holo')).toBe('trainer-gallery')
    expect(autoFoilPattern(card({ set_id: 'swsh9tg', number: '5', rarity: 'Ultra Rare' }), 'Holo')).toBe('trainer-gallery')
  })

  it('uses set rules: McDonald\'s cracked ice, Poké Ball reverse, promo cosmos', () => {
    expect(autoFoilPattern(card({ set_id: '2019sm', rarity: 'Rare Holo' }), 'Holo')).toBe('cracked-ice')
    expect(autoFoilPattern(card({ set_id: 'sv02', rarity: 'Common' }), 'Reverse Holo')).toBe('pokeball-reverse')
    expect(autoFoilPattern(card({ set_id: 'sv05', rarity: 'Common' }), 'Reverse Holo')).toBe('reverse')
    expect(autoFoilPattern(card({ set_id: 'swshp', rarity: 'Promo' }), 'Holo')).toBe('cosmos')
  })

  it('falls back on the variant, or to none', () => {
    expect(autoFoilPattern(card({ rarity: 'Common', set_id: 'base1' }), 'Reverse Holo')).toBe('reverse')
    expect(autoFoilPattern(card({ rarity: 'Rare' }), 'Holo')).toBe('holo')
    expect(autoFoilPattern(card({ rarity: 'Common' }), 'Normal')).toBeNull()
    expect(autoFoilPattern(card({ rarity: 'Rare' }), '1st Edition')).toBeNull()
    expect(autoFoilPattern({}, undefined)).toBeNull()
    expect(autoFoilPattern(null, null)).toBeNull()
  })

  it('a reverse copy of a holo card is reverse, not holo', () => {
    expect(autoFoilPattern(card({ set_id: 'sv06', rarity: 'Rare Holo' }), 'Reverse Holo')).toBe('reverse')
  })

  it('only emits known pattern ids', () => {
    for (const rule of FOIL_RULES) expect(FOIL_PATTERN_IDS).toContain(rule.pattern)
  })
})

describe('printing-detail tags', () => {
  it('matches names to patterns, ignoring case and accents', () => {
    expect(foilPatternFromTag('Cracked ice')).toBe('cracked-ice')
    expect(foilPatternFromTag('COSMOS')).toBe('cosmos')
    expect(foilPatternFromTag('Poké Ball')).toBe('pokeball-reverse')
    expect(foilPatternFromTag('Stamped')).toBeNull()
    expect(foilPatternFromTags([{ name: 'Stamped' }, 'Cosmos'])).toEqual({ pattern: 'cosmos', name: 'Cosmos' })
  })
})

describe('resolveFoilPattern override order', () => {
  const holoCard = card({ rarity: 'Rare Holo', set_id: 'sv05' })

  it('uses the rules when nothing overrides', () => {
    expect(resolveFoilPattern({ card: holoCard, variant: 'Holo' })).toMatchObject({ pattern: 'holo', source: 'rules' })
  })

  it('a tag beats the rules', () => {
    const result = resolveFoilPattern({ card: holoCard, variant: 'Holo', printingDetails: [{ name: 'Cracked ice' }] })
    expect(result).toMatchObject({ pattern: 'cracked-ice', source: 'tag', tagName: 'Cracked ice' })
  })

  it('the copy beats the tag and reports what Automatic would be', () => {
    const result = resolveFoilPattern({
      card: holoCard, variant: 'Holo', printingDetails: [{ name: 'Cracked ice' }], foilPattern: 'gold',
    })
    expect(result).toMatchObject({ pattern: 'gold', source: 'copy', auto: 'cracked-ice', rules: 'holo' })
  })

  it('ignores an unknown stored id and reports none for a plain card', () => {
    expect(resolveFoilPattern({ card: holoCard, variant: 'Holo', foilPattern: 'sparkles' }).source).toBe('rules')
    expect(resolveFoilPattern({ card: card({ rarity: 'Common' }), variant: 'Normal' })).toMatchObject({ pattern: null, source: 'none' })
  })
})
