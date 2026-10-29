import { describe, expect, it } from 'vitest'
import en from '../i18n/en'
import { fill } from '../delights/delights'
import {
  monthBars, parseYear, selectSlides, signed, startsInYear, typePercent, valuePoints, wrappedBlocks,
  wrappedShareSpec, wrappedYearFor,
} from './wrapped'

const t = key => key.split('.').reduce((v, part) => v?.[part], en) ?? key

const FULL = {
  year: 2026,
  history_starts: '2026-03-12',
  totals: { cards: 486, unique_cards: 312, sets_touched: 41, sets_completed: 6 },
  first_card: { name: 'Eevee', image: '/api/images/card/a/small' },
  best_pull: { name: 'Umbreon ex', image: '/api/images/card/b/small', price: 182 },
  biggest_month: { month: 6, count: 88 },
  top_pokemon: { dex_id: 133, name: 'Eevee', count: 23 },
  top_type: { type: 'psychic', count: 150 },
  top_illustrator: { name: 'Mitsuhiro Arita', count: 31 },
  value: { start: 900, end: 1400, peak: 1520, peak_date: '2026-10-12' },
  longest_streak: 41,
  wtp_wins: 112,
  quests_done: 260,
  badges_earned: 18,
  trades: { count: 4, incoming_value: 50, outgoing_value: 40 },
  products: { count: 2, spent: 30 },
}
const money = amount => `€${amount}`

describe('selectSlides', () => {
  it('plays all ten slides for a full year, in order', () => {
    expect(selectSlides(FULL)).toEqual([
      'cover', 'cards', 'first', 'pull', 'favourites', 'sets', 'value', 'streak', 'badges', 'summary',
    ])
  })

  it('keeps only the cover and the summary for an empty year', () => {
    const empty = { year: 2026, totals: { cards: 0, sets_completed: 0 }, trades: { count: 0 }, products: { count: 0 } }
    expect(selectSlides(empty)).toEqual(['cover', 'summary'])
  })

  it('skips the badges slide with no badges, trades or products', () => {
    const data = { ...FULL, badges_earned: 0, trades: { count: 0 }, products: { count: 0 } }
    expect(selectSlides(data)).not.toContain('badges')
    expect(selectSlides({ ...data, trades: { count: 1 } })).toContain('badges')
  })

  it('skips the sets slide with nothing completed and no closest set', () => {
    const data = { ...FULL, totals: { ...FULL.totals, sets_completed: 0 } }
    expect(selectSlides(data)).not.toContain('sets')
    expect(selectSlides({ ...data, closest_set: { name: 'Base', owned: 1, total: 2, missing: 1 } })).toContain('sets')
  })

  it('drops the streak slide when streaks and quests are switched off, or the numbers are zero', () => {
    expect(selectSlides(FULL, { showDaily: false })).not.toContain('streak')
    expect(selectSlides({ ...FULL, longest_streak: 0, wtp_wins: 0, quests_done: 0 })).not.toContain('streak')
  })

  it('skips the value slide without snapshots and returns nothing without data', () => {
    expect(selectSlides({ ...FULL, value: null })).not.toContain('value')
    expect(selectSlides(null)).toEqual([])
  })
})

describe('formatting', () => {
  it('uses last year for January and this year otherwise', () => {
    expect(wrappedYearFor(new Date(2027, 0, 5))).toBe(2026)
    expect(wrappedYearFor(new Date(2026, 11, 1))).toBe(2026)
    expect(wrappedYearFor(new Date(2026, 9, 29))).toBe(2026)
  })

  it('parses the route year and falls back on nonsense', () => {
    expect(parseYear('2026', 1)).toBe(2026)
    expect(parseYear('abc', 2026)).toBe(2026)
    expect(parseYear('99999', 2026)).toBe(2026)
  })

  it('knows when history starts inside the year', () => {
    expect(startsInYear(FULL)).toBe(true)
    expect(startsInYear({ ...FULL, history_starts: '2026-01-01' })).toBe(false)
    expect(startsInYear({ ...FULL, history_starts: '2025-06-01' })).toBe(false)
    expect(startsInYear({ ...FULL, history_starts: null })).toBe(false)
  })

  it('puts the sign outside the amount', () => {
    expect(signed(5, '€5')).toBe('+€5')
    expect(signed(-5, '€5')).toBe('−€5')
    expect(signed(0, '€0')).toBe('€0')
  })

  it('scales the month bars and marks the biggest month', () => {
    const monthly = [24, 38, 20, 43, 59, 88, 41, 30, 52, 61, 22, 8]
    const bars = monthBars({ ...FULL, monthly })
    expect(bars).toHaveLength(12)
    expect(bars[5]).toMatchObject({ height: 100, top: true })
    expect(bars.filter(bar => bar.top)).toHaveLength(1)
    expect(monthBars(FULL)).toBeNull()
    expect(monthBars({ ...FULL, monthly: new Array(12).fill(0) })).toBeNull()
  })

  it('works out the top type share', () => {
    expect(typePercent(FULL)).toBe(31)
    expect(typePercent({ ...FULL, top_type: { type: 'fire', count: 1, percent: 40 } })).toBe(40)
    expect(typePercent({ ...FULL, top_type: null })).toBe(0)
  })

  it('draws the value line from start, peak and end when there is no series', () => {
    const points = valuePoints(FULL.value)
    expect(points).toHaveLength(3)
    expect(points[1].y).toBe(1)
    expect(points[0].y).toBe(0)
  })
})

describe('share picture and hide-values', () => {
  const options = { data: FULL, t, money, locale: 'en', showDaily: true }

  it('builds the blocks from the year, flagging every amount', () => {
    const blocks = wrappedBlocks(options)
    expect(blocks[0]).toMatchObject({ type: 'number', value: '486' })
    const pull = blocks.find(block => block.type === 'card')
    expect(pull).toMatchObject({ url: '/api/images/card/b/small', amount: true })
    expect(blocks.filter(block => block.amount).map(block => block.type)).toEqual(['card', 'line'])
  })

  it('masks every amount in the picture while values are hidden, and none otherwise', () => {
    const shown = JSON.stringify(wrappedShareSpec({ ...options, hideValues: false }).blocks)
    expect(shown).toContain('€182')
    expect(shown).toContain('€1400')
    const hidden = JSON.stringify(wrappedShareSpec({ ...options, hideValues: true }).blocks)
    expect(hidden).not.toContain('182')
    expect(hidden).not.toContain('1400')
    expect(hidden).toContain('••••')
  })

  it('leaves out lines with no data, and the streak when streaks are off', () => {
    const blocks = wrappedBlocks({ ...options, showDaily: false, data: { ...FULL, value: null, best_pull: null, badges_earned: 0 } })
    const text = blocks.map(block => block.text || '').join('|')
    expect(blocks.some(block => block.type === 'card')).toBe(false)
    expect(text).not.toContain('streak')
    expect(text).not.toContain('Collection')
  })

  it('titles the picture with the year', () => {
    expect(wrappedShareSpec({ ...options, hideValues: false, name: 'Ash' })).toMatchObject({ title: fill(en.wrapped.shareTitle, { year: 2026 }), subtitle: 'Ash', format: 'story' })
  })
})
