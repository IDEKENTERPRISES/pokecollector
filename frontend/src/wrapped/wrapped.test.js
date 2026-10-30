import { describe, expect, it } from 'vitest'
import en from '../i18n/en'
import { fill } from '../delights/delights'
import {
  monthCells, pad3, parseYear, personaKey, rarityOf, selectSlides, signed, startsInYear, typePercent, valueChart,
  weeksAndDays, wrappedMoney, wrappedYearFor,
} from './wrapped'
import { trainerCardLabel, trainerCardLayout, trainerCardModel } from './trainerCard'
import { pictureAlt, pictureFileName, pictureOptions, statPosterPlan } from './shareWrapped'

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

  it('builds the month columns: untracked months before the start, the biggest month on top', () => {
    const monthly = [0, 0, 82, 43, 59, 88, 41, 30, 52, 61, 22, 8]
    const chart = monthCells({ ...FULL, monthly })
    expect(chart.cells).toHaveLength(12)
    expect(chart.cells.slice(0, 2).every(cell => cell.untracked)).toBe(true)
    expect(chart.cells[2].untracked).toBe(false)
    expect(chart.cells[5]).toMatchObject({ top: true, ratio: 1 })
    expect(chart.few).toBe(false)
    expect(monthCells({ ...FULL, monthly: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 5], biggest_month: { month: 12, count: 5 } }).few).toBe(true)
    expect(monthCells(FULL)).toBeNull()
    expect(monthCells({ ...FULL, monthly: new Array(12).fill(0) })).toBeNull()
  })

  it('writes money like the mockups and masks it with hide-values', () => {
    const money = wrappedMoney({ symbol: '£' })
    expect(money(182.5)).toBe('£183')
    expect(money(888)).toBe('£888')
    expect(money(1400)).toBe('£1.4k')
    expect(money(1520)).toBe('£1.52k')
    expect(money(100000)).toBe('£100k')
    expect(money(1234567)).toBe('£1.23M')
    expect(wrappedMoney({ symbol: '£', hidden: true })(1400)).toBe('£•••')
  })

  it('draws the value chart in the mockup box from the monthly series', () => {
    const series = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((month, i) => ({ month, value: [888, 950, 1050, 1250, 1190, 1350, 1560, 1520, 1460, 1400][i] }))
    const chart = valueChart({ ...FULL.value, series })
    expect(chart.points[0]).toMatchObject({ x: 10, y: 270 })
    expect(chart.points.at(-1).x).toBe(334)
    expect(chart.points[chart.peak]).toMatchObject({ month: 9, y: 50 })
    expect(chart.ticks.map(tick => tick.month)).toEqual([3, 5, 7, 9, 11])
    expect(valueChart(FULL.value).points).toHaveLength(3)
  })

  it('names the persona from 10 cards on, and the rarity tier from the card count', () => {
    expect(personaKey(FULL)).toBe('psychic')
    expect(personaKey({ ...FULL, totals: { ...FULL.totals, cards: 9 } })).toBeNull()
    expect(personaKey({ ...FULL, top_type: null })).toBeNull()
    expect(rarityOf(FULL)).toEqual({ key: 'rare', mark: '★' })
    expect(rarityOf({ totals: { cards: 8 } }).key).toBe('common')
    expect(rarityOf({ totals: { cards: 2000 } }).key).toBe('ultraRare')
    expect(pad3(4)).toBe('004')
    expect(weeksAndDays(41)).toEqual({ weeks: 5, days: 6 })
  })

  it('works out the top type share', () => {
    expect(typePercent(FULL)).toBe(31)
    expect(typePercent({ ...FULL, top_type: { type: 'fire', count: 1, percent: 40 } })).toBe(40)
    expect(typePercent({ ...FULL, top_type: null })).toBe(0)
  })

})

describe('trainer card and share pictures', () => {
  const base = { data: FULL, t, locale: 'en-GB', name: 'Ash', showDaily: true }
  const shown = { ...base, money: wrappedMoney({ symbol: '£' }) }
  const masked = { ...base, money: wrappedMoney({ symbol: '£', hidden: true }) }

  it('shows the persona, the top pull, four stats and the rarity', () => {
    const model = trainerCardModel({ ...shown, footer: 'PokéCollector · 010/010' })
    expect(model).toMatchObject({ key: 'psychic', persona: 'Mystic', name: 'Ash', rarity: '★ Rare', since: null })
    expect(model.art).toMatchObject({ kind: 'card', name: 'Umbreon ex', price: '£182' })
    expect(model.stats.map(stat => stat.value)).toEqual(['486', '6', 'Eevee', '41 days'])
    const layout = trainerCardLayout(model)
    expect(layout.art).toMatchObject({ y: 89, h: 178 })
    expect(layout.stats).toHaveLength(4)
  })

  it('a new trainer gets the colorless card, the since chip and a taller art window', () => {
    const thin = {
      year: 2026, history_starts: '2026-11-03', partial_history: true, totals: { cards: 8, sets_completed: 0 },
      best_pull: { name: 'Psyduck', price: 4, image: '/x' }, top_pokemon: { name: 'Psyduck', count: 3 }, top_type: { type: 'water', count: 5 },
    }
    const model = trainerCardModel({ ...shown, data: thin })
    expect(model).toMatchObject({ key: 'colorless', persona: 'Trainer', light: true, rarity: '● Common' })
    expect(model.since).toBe('Collected since 3 November')
    const layout = trainerCardLayout(model)
    expect(layout.chip).toMatchObject({ y: 85, h: 27 })
    expect(layout.art.y).toBe(124)
    expect(layout.art.h).toBeGreaterThan(220)
    expect(layout.mini).toMatchObject({ w: 118, h: 165 })
  })

  it('masks every amount with hide-values, and file names and alt text carry none', () => {
    const model = trainerCardModel(masked)
    expect(model.art.price).toBe('£•••')
    expect(JSON.stringify(trainerCardLayout(model))).not.toContain('182')
    const options = pictureOptions(shown)
    for (const kind of ['card', 'poster']) {
      expect(pictureFileName(kind, 2026)).not.toMatch(/£|182|1\.4/)
      expect(pictureAlt(kind, options)).not.toContain('182')
      expect(pictureAlt(kind, options)).toContain('Umbreon ex')
    }
    expect(trainerCardLabel(model, t)).not.toContain('•')
  })

  it('plans the stat poster tiles from what the year has', () => {
    const options = pictureOptions(shown)
    expect(statPosterPlan(options)).toEqual({ top: true, streak: true, sets: true, rail: ['badges', 'trades', 'value'] })
    expect(statPosterPlan({ ...options, showDaily: false, data: { ...FULL, best_pull: null, value: null } })).toMatchObject({ top: false, streak: false, rail: ['badges', 'trades'] })
  })
})
