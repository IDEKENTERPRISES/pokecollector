import { describe, expect, it } from 'vitest'
import en from '../../i18n/en.js'
import de from '../../i18n/de.js'
import { factLabelKey, fill, formatHeight, formatWeight, splashText, typeColour } from './format.js'

const translator = table => key => key.split('.').reduce((node, part) => node?.[part], table) ?? key

const pikachu = {
  dex_id: 25,
  name: 'Pikachu',
  genus: 'Mouse Pokémon',
  generation: 1,
  region: 'Kanto',
  types: ['electric'],
  height_m: 0.4,
  weight_kg: 6,
  shiny: false,
}
const fact = { kind: 'signature-move', title: 'Volt Tackle', text: 'A charge that also hurts the user.' }

describe('splashText', () => {
  it('builds the card, the box and the announcement in English, with both units', () => {
    expect(splashText(pikachu, { t: translator(en), language: 'en', fact })).toEqual({
      number: 'No. 0025',
      name: 'Pikachu',
      meta: 'Mouse Pokémon · Gen 1 · Kanto',
      height: '0.4 m · 1′04″',
      weight: '6.0 kg · 13.2 lbs',
      fact: { label: 'Signature move', title: 'Volt Tackle', text: 'A charge that also hurts the user.' },
      wild: ['Wild PIKACHU', 'appeared!'],
      announcement: 'A wild Pikachu appeared! No. 25, Generation 1, Kanto. '
        + 'Height 0.4 metres, weight 6 kilograms, 13.2 pounds. Signature move Volt Tackle: A charge that also hurts the user.',
    })
  })

  it('in German', () => {
    const text = splashText({ ...pikachu, name: 'Furnifraß', weight_kg: 2.5 }, { t: translator(de), language: 'de', fact })
    expect(text.number).toBe('Nr. 0025')
    expect(text.weight).toBe('2,5 kg · 5,5 lbs')
    expect(text.fact.label).toBe('Signatur-Attacke')
    expect(text.wild).toEqual(['Ein wildes FURNIFRASS', 'erscheint!'])
    expect(text.announcement.startsWith('Ein wildes Furnifraß erscheint! Nr. 25, Generation 1, Kanto. Größe 0,4 Meter')).toBe(true)
  })

  it('metric or imperial only, as the owner may choose', () => {
    expect(splashText(pikachu, { t: translator(en), units: 'metric' })).toMatchObject({ height: '0.4 m', weight: '6.0 kg' })
    const imperial = splashText(pikachu, { t: translator(en), units: 'imperial' })
    expect(imperial).toMatchObject({ height: '1′04″', weight: '13.2 lbs' })
    expect(imperial.announcement).toContain('Height 1 feet 4 inches, weight 13.2 pounds.')
  })

  it('says when it is shiny, and leaves out what the server does not have', () => {
    const text = splashText({ ...pikachu, shiny: true, genus: null, height_m: null, weight_kg: null }, { t: translator(en) })
    expect(text.meta).toBe('Gen 1 · Kanto')
    expect(text.height).toBeNull()
    expect(text.fact).toBeNull()
    expect(text.announcement).toBe('A wild shiny Pikachu appeared! No. 25, Generation 1, Kanto.')
  })
})

describe('measures', () => {
  it('heights in metres and feet and inches, like the Pokédex', () => {
    expect(formatHeight(0.4)).toMatchObject({ metric: '0.4 m', imperial: '1′04″' })
    expect(formatHeight(1.7)).toMatchObject({ metric: '1.7 m', imperial: '5′07″' })
    expect(formatHeight(14.5)).toMatchObject({ imperial: '47′07″' })
    expect(formatHeight(0)).toBeNull()
  })

  it('weights in kilograms and pounds', () => {
    expect(formatWeight(90.5)).toMatchObject({ metric: '90.5 kg', imperial: '199.5 lbs' })
    expect(formatWeight(6, { language: 'not a locale!' })).toMatchObject({ metric: '6.0 kg' })
    expect(formatWeight(null)).toBeNull()
  })
})

describe('helpers', () => {
  it('fill inserts values literally', () => {
    expect(fill('{a} and {b} and {missing}', { a: '$&', b: 2 })).toBe('$& and 2 and {missing}')
  })

  it('labels every kind of fact the server sends', () => {
    for (const kind of ['signature-move', 'move', 'ability', 'hidden-ability', 'evolution', 'trait', 'pokedex']) {
      expect(translator(en)(factLabelKey(kind)), kind).not.toMatch(/^splash\./)
    }
    expect(factLabelKey('something-new')).toBe('splash.factTrait')
  })

  it('maps all 18 game types onto the 11 energy colours', () => {
    expect(typeColour(['electric'])).toBe('var(--type-lightning)')
    expect(typeColour(['bug', 'flying'])).toBe('var(--type-grass)')
    expect(typeColour(['steel'])).toBe('var(--type-metal)')
    expect(typeColour(['dark'])).toBe('var(--type-darkness)')
    expect(typeColour(undefined)).toBe('var(--type-colorless)')
  })
})
