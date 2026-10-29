import { describe, expect, it } from 'vitest'
import { hasRecap, recapBlocks, recapShareSpec, signedAmount, weekRange } from './recap'

const t = key => ({
  'recap.cardsAdded': 'Cards added',
  'recap.valueChange': 'Value change',
  'recap.closestSet': '{set}: {missing} to go',
  'recap.streak': '{count}-day streak',
  'recap.shareTitle': 'My week',
  'wtp.shareApp': 'PokéCollector',
}[key] ?? key)
const money = amount => `€${amount.toFixed(2)}`

const data = {
  show: true,
  has_activity: true,
  week_start: '2026-10-26',
  week_end: '2026-11-01',
  cards_added: 7,
  value: { start: 100, end: 95.5, change: -4.5, percent: -4.5 },
  best_pull: { item_id: 9, card_id: 'a_en', name: 'Charizard', price: 30, image: '/api/images/card/a_en/small' },
  closest_set: { set_id: 'base1_en', name: 'Base Set', missing: 2 },
  streak: { current: 5, best: 9 },
  badges: [],
}

describe('weekly recap helpers', () => {
  it('shows only inside the window and for a week with something in it', () => {
    expect(hasRecap(data)).toBe(true)
    expect(hasRecap({ ...data, show: false })).toBe(false)
    expect(hasRecap({ ...data, has_activity: false })).toBe(false)
    expect(hasRecap(null)).toBe(false)
  })

  it('labels the week and signs the value change', () => {
    expect(weekRange(data, 'en-GB')).toContain('26')
    expect(signedAmount(-4.5, '€4.50')).toBe('−€4.50')
    expect(signedAmount(4.5, '€4.50')).toBe('+€4.50')
  })

  it('builds the picture blocks, leaving the streak out when streaks are off', () => {
    const withStreak = recapBlocks({ data, t, money, showStreak: true })
    expect(withStreak.map(b => b.type)).toEqual(['number', 'number', 'card', 'line', 'line'])
    expect(withStreak[1]).toMatchObject({ value: '−€4.50', amount: true })
    expect(withStreak[3].text).toBe('Base Set: 2 to go')
    expect(recapBlocks({ data, t, money, showStreak: false }).map(b => b.type)).toEqual(['number', 'number', 'card', 'line'])
  })

  it('masks amounts in the picture when hide-values is on', () => {
    const spec = recapShareSpec({ data, t, money, showStreak: true, hideValues: true })
    expect(JSON.stringify(spec)).not.toMatch(/4\.50|30\.00/)
    expect(spec.blocks[0].value).toBe('7')
  })
})
