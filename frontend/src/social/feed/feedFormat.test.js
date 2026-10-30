import { describe, expect, it } from 'vitest'
import en from '../../i18n/en'
import {
  ageLabel, cleanComment, dayLabel, feedState, groupByDay, isOn, reactionLabel, reactionSummary, setPathFor, toggleReaction,
} from './feedFormat'

const t = (path) => path.split('.').reduce((value, part) => value?.[part], en) ?? path
const NOW = new Date(2026, 9, 30, 14, 0) // Fri 30 Oct, 14:00 local time
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString()

describe('dayLabel', () => {
  it('names today and yesterday, then the weekday and date', () => {
    expect(dayLabel(at(30, 9), t, NOW, 'en-GB')).toBe('Today')
    expect(dayLabel(at(29, 20), t, NOW, 'en-GB')).toBe('Yesterday')
    expect(dayLabel(at(26, 19), t, NOW, 'en-GB')).toBe('Mon 26 Oct')
  })
})

describe('ageLabel', () => {
  it('counts hours today, and writes them out for VoiceOver', () => {
    expect(ageLabel(at(30, 12), t, { now: NOW })).toBe('2 h ago')
    expect(ageLabel(at(30, 12), t, { now: NOW, spoken: true })).toBe('2 hours ago')
    expect(ageLabel(at(30, 13, 20), t, { now: NOW })).toBe('40 min ago')
    expect(ageLabel(new Date(2026, 9, 30, 13, 59, 50).toISOString(), t, { now: new Date(2026, 9, 30, 14, 0, 20) })).toBe('Just now')
  })

  it('gives a clock time on earlier days', () => {
    expect(ageLabel(at(29, 20, 14), t, { now: NOW })).toBe('Yesterday at 20:14')
    expect(ageLabel(at(29, 20, 14), t, { now: NOW, spoken: true })).toBe('Yesterday')
    expect(ageLabel(at(26, 19, 40), t, { now: NOW, locale: 'en-GB' })).toBe('Mon at 19:40')
    expect(ageLabel(at(20, 8, 5), t, { now: NOW, locale: 'en-GB' })).toBe('20 Oct at 08:05')
  })
})

describe('groupByDay', () => {
  it('keeps the server order and starts a group when the day changes', () => {
    const items = [
      { id: 3, occurred_at: at(30, 12) },
      { id: 2, occurred_at: at(30, 9) },
      { id: 1, occurred_at: at(29, 22) },
    ]
    const groups = groupByDay(items, t, NOW, 'en-GB')
    expect(groups.map(group => [group.label, group.items.map(item => item.id)])).toEqual([
      ['Today', [3, 2]],
      ['Yesterday', [1]],
    ])
  })
})

describe('setPathFor', () => {
  it('drops the language suffix of a set key', () => {
    expect(setPathFor({ set_key: 'sv08_en', lang: 'en' })).toBe('/sets/sv08')
    expect(setPathFor({ set_key: 'sv08', lang: 'en' })).toBe('/sets/sv08')
    expect(setPathFor({})).toBeNull()
  })
})

describe('toggleReaction', () => {
  const base = { counts: { cheer: 2, wow: 0, fire: 1, heart: 0 }, mine: ['cheer'] }

  it('adds a reaction and counts it', () => {
    expect(toggleReaction(base, 'wow')).toEqual({ counts: { cheer: 2, wow: 1, fire: 1, heart: 0 }, mine: ['cheer', 'wow'] })
  })

  it('removes your reaction and never goes below zero', () => {
    expect(toggleReaction(base, 'cheer')).toEqual({ counts: { cheer: 1, wow: 0, fire: 1, heart: 0 }, mine: [] })
    expect(toggleReaction({ counts: { cheer: 0 }, mine: ['cheer'] }, 'cheer').counts.cheer).toBe(0)
  })

  it('does not change what it was given', () => {
    toggleReaction(base, 'fire')
    expect(base.mine).toEqual(['cheer'])
  })
})

describe('labels', () => {
  it('reads like the artboards', () => {
    expect(reactionLabel('Cheer', 2, true, t)).toBe('Cheer, 2, you reacted')
    expect(reactionLabel('Wow', 0, false, t)).toBe('Wow')
    expect(reactionLabel('Fire', 1, false, t)).toBe('Fire, 1')
    expect(reactionSummary({ cheer: 2, wow: 0, fire: 0, heart: 1 }, t)).toBe('2 cheers, 1 love it')
  })
})

describe('cleanComment', () => {
  it('trims, and refuses empty or too long text', () => {
    expect(cleanComment('  Nice one \n')).toBe('Nice one')
    expect(cleanComment('   ')).toBeNull()
    expect(cleanComment('x'.repeat(280))).toHaveLength(280)
    expect(cleanComment('x'.repeat(281))).toBeNull()
    expect(cleanComment(`  ${'y'.repeat(280)}  `)).toHaveLength(280)
  })
})

describe('feedState', () => {
  it('picks the one state the segment shows', () => {
    expect(feedState({ offline: true, isLoading: false, error: null, itemCount: 0 })).toBe('offline')
    expect(feedState({ offline: true, isLoading: false, error: null, itemCount: 3 })).toBe('list')
    expect(feedState({ offline: false, isLoading: true, error: null, itemCount: 0 })).toBe('loading')
    expect(feedState({ offline: false, isLoading: false, error: new Error('x'), itemCount: 0 })).toBe('error')
    expect(feedState({ offline: false, isLoading: false, error: null, itemCount: 0 })).toBe('empty')
  })
})

describe('isOn', () => {
  it('reads the settings strings and falls back when a key is missing', () => {
    expect(isOn({ a: 'true' }, 'a')).toBe(true)
    expect(isOn({ a: 'false' }, 'a', true)).toBe(false)
    expect(isOn({}, 'a', true)).toBe(true)
  })
})
