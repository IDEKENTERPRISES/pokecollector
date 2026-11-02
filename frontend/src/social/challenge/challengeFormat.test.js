import { describe, expect, it } from 'vitest'
import {
  anyoneStarted, badgeCount, finishersOf, formatWhen, fractionOf, leftKey, placeKey, podiumSlots, resultLine, timeLeft, weekNumber,
} from './challengeFormat'

describe('weekNumber', () => {
  it('reads the ISO week', () => {
    expect(weekNumber('2026-W44')).toBe(44)
    expect(weekNumber('2026-W04')).toBe(4)
    expect(weekNumber('nope')).toBeNull()
    expect(weekNumber(undefined)).toBeNull()
  })
})

describe('timeLeft', () => {
  const end = '2026-11-01T23:59:00+00:00'
  const at = iso => new Date(iso).getTime()
  it('counts whole days first', () => {
    expect(timeLeft(end, at('2026-10-30T14:00:00Z'))).toEqual({ unit: 'days', count: 2 })
    expect(timeLeft(end, at('2026-10-31T23:59:00Z'))).toEqual({ unit: 'days', count: 1 })
  })
  it('falls back to hours, then minutes, then ended', () => {
    expect(timeLeft(end, at('2026-11-01T00:00:00Z'))).toEqual({ unit: 'hours', count: 23 })
    expect(timeLeft(end, at('2026-11-01T20:00:00Z'))).toEqual({ unit: 'hours', count: 3 })
    expect(timeLeft(end, at('2026-11-01T23:30:30Z'))).toEqual({ unit: 'minutes', count: 29 })
    expect(timeLeft(end, at('2026-11-01T23:58:59Z'))).toEqual({ unit: 'minutes', count: 1 })
    expect(timeLeft(end, at('2026-11-02T00:00:00Z'))).toEqual({ unit: 'ended', count: 0 })
    expect(timeLeft('garbage', 0)).toBeNull()
  })
  it('names the string for a countdown', () => {
    expect(leftKey({ unit: 'days', count: 2 })).toEqual({ key: 'leftDays', count: 2 })
    expect(leftKey({ unit: 'days', count: 1 })).toEqual({ key: 'leftDayOne', count: 1 })
    expect(leftKey({ unit: 'hours', count: 1 })).toEqual({ key: 'leftHourOne', count: 1 })
    expect(leftKey({ unit: 'minutes', count: 5 })).toEqual({ key: 'leftMinutes', count: 5 })
    expect(leftKey({ unit: 'ended', count: 0 })).toEqual({ key: 'leftEnded', count: 0 })
    expect(leftKey(null)).toBeNull()
  })
})

describe('formatWhen', () => {
  it('writes the weekday and a 24-hour time', () => {
    const iso = '2026-10-27T21:14:00+00:00'
    expect(formatWhen(iso, 'en')).toMatch(/^[A-Z][a-z]{2} \d{2}:\d{2}$/)
    expect(formatWhen(iso, 'en', { long: true })).toMatch(/^[A-Z][a-z]+day \d{2}:\d{2}$/)
  })
  it('gives null for no or a bad date', () => {
    expect(formatWhen(null, 'en')).toBeNull()
    expect(formatWhen('x', 'en')).toBeNull()
  })
})

describe('places and progress', () => {
  it('names the place strings', () => {
    expect(placeKey(1)).toBe('placeFirst')
    expect(placeKey(3)).toBe('placeThird')
    expect(placeKey(4)).toBeNull()
  })
  it('bounds the fraction', () => {
    expect(fractionOf(14, 20)).toBe(0.7)
    expect(fractionOf(30, 20)).toBe(1)
    expect(fractionOf(-1, 20)).toBe(0)
    expect(fractionOf(3, 0)).toBe(0)
  })
  it('lists finishers in order without the viewer', () => {
    const board = [
      { user: { id: 4 }, finished_at: '2026-10-29T19:02:00+00:00' },
      { user: { id: 1 }, finished_at: '2026-10-28T10:00:00+00:00' },
      { user: { id: 3 }, finished_at: '2026-10-27T21:14:00+00:00' },
      { user: { id: 2 }, finished_at: null },
    ]
    expect(finishersOf(board, 1).map(entry => entry.user.id)).toEqual([3, 4])
    expect(finishersOf(undefined, 1)).toEqual([])
  })
  it('always gives three slots', () => {
    const slots = podiumSlots([{ place: 2, id: 'b' }, { place: 1, id: 'a' }])
    expect(slots.map(slot => slot.place)).toEqual([1, 2, 3])
    expect(slots[0].entry.id).toBe('a')
    expect(slots[2].entry).toBeNull()
  })
  it('knows when nobody has started', () => {
    expect(anyoneStarted([{ progress: 0 }, { progress: 0 }])).toBe(false)
    expect(anyoneStarted([{ progress: 0 }, { progress: 2 }])).toBe(true)
    expect(anyoneStarted(null)).toBe(false)
  })
  it('reads the badge count', () => {
    expect(badgeCount('challenge_5')).toBe(5)
    expect(badgeCount('x')).toBeNull()
  })
  it('picks the viewer line', () => {
    expect(resultLine({ finished_at: 'x', place: 3 })).toEqual({ kind: 'finishedPlace', place: 3 })
    expect(resultLine({ finished_at: 'x', place: null })).toEqual({ kind: 'finished', place: null })
    expect(resultLine({ finished_at: null, place: 2, progress: 18 })).toEqual({ kind: 'placed', place: 2, progress: 18 })
    expect(resultLine({ finished_at: null, place: null, progress: 14 })).toEqual({ kind: 'reached', progress: 14 })
    expect(resultLine(null)).toEqual({ kind: 'reached', progress: 0 })
  })
})
