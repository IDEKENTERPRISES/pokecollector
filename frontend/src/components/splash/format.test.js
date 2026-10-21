import { describe, expect, it } from 'vitest'
import en from '../../i18n/en.js'
import de from '../../i18n/de.js'
import { fill, formatWeight, splashText, typeColour } from './format.js'

const translator = table => key => key.split('.').reduce((node, part) => node?.[part], table) ?? key

const pikachu = {
  dex_id: 25,
  name: 'Pikachu',
  generation: 1,
  region: 'Kanto',
  types: ['electric'],
  weight_kg: 6,
  fact: 'It stores electricity in its cheeks.',
}

describe('splashText', () => {
  it('builds the minimal card and the announcement in English', () => {
    expect(splashText(pikachu, { t: translator(en), language: 'en' })).toEqual({
      number: 'No. 0025',
      name: 'Pikachu',
      meta: 'Gen 1 · Kanto · 6.0 kg',
      fact: 'It stores electricity in its cheeks.',
      announcement: 'A wild Pikachu appeared! No. 25, Generation 1, Kanto, 6 kilograms. It stores electricity in its cheeks.',
    })
  })

  it('in German', () => {
    const text = splashText({ ...pikachu, weight_kg: 2.5 }, { t: translator(de), language: 'de' })
    expect(text.number).toBe('Nr. 0025')
    expect(text.meta).toBe('Gen. 1 · Kanto · 2,5 kg')
    expect(text.announcement.startsWith('Ein wildes Pikachu erscheint! Nr. 25, Generation 1, Kanto, 2,5 Kilogramm.')).toBe(true)
  })

  it('in pounds', () => {
    const text = splashText(pikachu, { t: translator(en), language: 'en', unit: 'lb' })
    expect(text.meta).toBe('Gen 1 · Kanto · 13.2 lbs')
    expect(text.announcement).toContain('13.2 pounds')
  })

  it('leaves the weight out when the server has none', () => {
    const text = splashText({ ...pikachu, weight_kg: null, fact: null }, { t: translator(en) })
    expect(text.meta).toBe('Gen 1 · Kanto')
    expect(text.fact).toBe('')
    expect(text.announcement).toBe('A wild Pikachu appeared! No. 25, Generation 1, Kanto.')
  })
})

describe('helpers', () => {
  it('fill inserts values literally', () => {
    expect(fill('{a} and {b} and {missing}', { a: '$&', b: 2 })).toBe('$& and 2 and {missing}')
  })

  it('formatWeight survives an unknown locale', () => {
    expect(formatWeight(6, { language: 'not a locale!' })).toEqual({ short: '6.0 kg', value: '6' })
    expect(formatWeight(0)).toBeNull()
  })

  it('maps all 18 game types onto the 11 energy colours', () => {
    expect(typeColour(['electric'])).toBe('var(--type-lightning)')
    expect(typeColour(['bug', 'flying'])).toBe('var(--type-grass)')
    expect(typeColour(['steel'])).toBe('var(--type-metal)')
    expect(typeColour(['dark'])).toBe('var(--type-darkness)')
    expect(typeColour([])).toBe('var(--type-colorless)')
    expect(typeColour(undefined)).toBe('var(--type-colorless)')
  })
})
