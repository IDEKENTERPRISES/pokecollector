import { describe, expect, it } from 'vitest'
import { daysLeft, groupOffers, parseServerTime, shortAgeLabel, swapStatus, tradeVerdict } from './swapHelpers'

const offer = (extra = {}) => ({
  id: 1, state: 'proposed', revision: 1, your_turn: true, partner: { username: 'Brock' }, unavailable: [], items: [],
  updated_at: '2026-10-30T10:00:00', ...extra,
})

describe('swapStatus', () => {
  it('words each state', () => {
    expect(swapStatus(offer())).toMatchObject({ tone: 'yellow', key: 'swaps.status.yourTurn' })
    expect(swapStatus(offer({ revision: 2 }))).toMatchObject({ tone: 'yellow', key: 'swaps.status.yourTurnCountered' })
    expect(swapStatus(offer({ your_turn: false }))).toMatchObject({ tone: 'gray', key: 'swaps.status.waiting' })
    expect(swapStatus(offer({ state: 'accepted', your_turn: false }))).toMatchObject({ tone: 'green', key: 'swaps.status.accepted' })
    expect(swapStatus(offer({ state: 'accepted', you_confirmed: true }))).toMatchObject({ key: 'swaps.status.waitingSwapped' })
    expect(swapStatus(offer({ state: 'accepted', unavailable: [{}] }))).toMatchObject({ tone: 'red', key: 'swaps.status.blocked' })
    expect(swapStatus(offer({ state: 'completed' }))).toMatchObject({ tone: 'green', key: 'swaps.status.swapped' })
    expect(swapStatus(offer({ state: 'expired' }))).toMatchObject({ tone: 'gray', key: 'swaps.status.expired' })
  })
})

describe('tradeVerdict', () => {
  it('keeps the thresholds', () => {
    expect(tradeVerdict({ gives: 100, gets: 115 }).key).toBe('gain')
    expect(tradeVerdict({ gives: 100, gets: 95 }).key).toBe('fair')
    expect(tradeVerdict({ gives: 100, gets: 94 }).key).toBe('close')
    expect(tradeVerdict({ gives: 100, gets: 80 }).key).toBe('lose')
    expect(tradeVerdict({}).key).toBe('empty')
    expect(tradeVerdict({ gives: 5, gets: 5, missingPrices: 1 })).toMatchObject({ key: 'missing', position: null })
  })
  it('places the marker across +-30 %', () => {
    expect(tradeVerdict({ gives: 6.1, gets: 6.4 }).position).toBeCloseTo(0.582, 2)
    expect(tradeVerdict({ gives: 3.8, gets: 14.2 }).position).toBe(1)
    expect(tradeVerdict({ gives: 10, gets: 0 }).position).toBe(0)
  })
})

describe('time helpers', () => {
  const now = Date.parse('2026-10-30T12:00:00Z')
  it('reads naive server times as UTC', () => {
    expect(parseServerTime('2026-10-30T10:00:00')).toBe(Date.parse('2026-10-30T10:00:00Z'))
    expect(shortAgeLabel('2026-10-30T10:00:00', now)).toBe('2 h')
    expect(shortAgeLabel('2026-10-30T11:20:00', now)).toBe('40 min')
    expect(shortAgeLabel('2026-10-28T12:00:00', now)).toBe('2 d')
    expect(daysLeft('2026-11-13T12:00:00', now)).toBe(14)
  })
})

describe('groupOffers', () => {
  it('splits by whose turn it is', () => {
    const data = {
      incoming: [offer({ id: 1 }), offer({ id: 2, state: 'accepted', your_turn: false })],
      outgoing: [offer({ id: 3, your_turn: false })],
      history: [offer({ id: 4, state: 'declined' })],
    }
    const groups = groupOffers(data)
    expect(groups.yourTurn.map(o => o.id)).toEqual([1])
    expect(groups.accepted.map(o => o.id)).toEqual([2])
    expect(groups.waiting.map(o => o.id)).toEqual([3])
    expect(groups.finished.map(o => o.id)).toEqual([4])
  })
})
