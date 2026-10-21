import { describe, expect, it } from 'vitest'
import { correctionNoticeParts } from './searchCorrection'

const TEMPLATE = 'Searching for {to}. "{from}" was not found.'

describe('correctionNoticeParts', () => {
  it('bolds the corrected name and quotes what was typed', () => {
    expect(correctionNoticeParts(TEMPLATE, { from: 'Morbeko', to: 'Morpeko' })).toEqual([
      { text: 'Searching for ', strong: false },
      { text: 'Morpeko', strong: true },
      { text: '. "Morbeko" was not found.', strong: false },
    ])
  })
  it('gives nothing when the search was not corrected', () => {
    expect(correctionNoticeParts(TEMPLATE, undefined)).toEqual([])
    expect(correctionNoticeParts(TEMPLATE, { from: '', to: 'Morpeko' })).toEqual([])
  })
})
