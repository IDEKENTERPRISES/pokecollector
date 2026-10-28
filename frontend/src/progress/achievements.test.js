import { describe, expect, it } from 'vitest'
import { TRACKS, gymBadgeStates, groupByTrack, isBusy, mergeQueue } from './achievements'

describe('gymBadgeStates', () => {
  it('always gives the eight tracks in order, unlit when the server sends nothing', () => {
    const states = gymBadgeStates(undefined)
    expect(states.map(s => s.track)).toEqual(TRACKS)
    expect(states).toHaveLength(8)
    expect(states.every(s => s.tier === null)).toBe(true)
  })

  it('lights a track by the tier the server reports and ignores unknown tiers', () => {
    const states = gymBadgeStates([
      { track: 'pokedex', tier: 'gold' },
      { track: 'collection', tier: 'silver' },
      { track: 'sets', tier: 'platinum' },
      { track: 'unknown', tier: 'bronze' },
    ])
    const byTrack = Object.fromEntries(states.map(s => [s.track, s.tier]))
    expect(byTrack).toMatchObject({ pokedex: 'gold', collection: 'silver', sets: null, daily: null })
    expect(states).toHaveLength(8)
  })
})

describe('groupByTrack', () => {
  it('groups in track order and drops empty tracks', () => {
    const groups = groupByTrack([
      { id: 'a', track: 'pokedex' }, { id: 'b', track: 'collection' }, { id: 'c', track: 'pokedex' },
    ])
    expect(groups.map(g => g.track)).toEqual(['collection', 'pokedex'])
    expect(groups[1].items.map(i => i.id)).toEqual(['a', 'c'])
  })
})

describe('mergeQueue', () => {
  const unlock = id => ({ id })

  it('appends new unlocks in order and keeps the same array when nothing is new', () => {
    const queue = [unlock('a')]
    const next = mergeQueue(queue, [unlock('a'), unlock('b'), unlock('c')])
    expect(next.map(u => u.id)).toEqual(['a', 'b', 'c'])
    expect(mergeQueue(next, [unlock('b')])).toBe(next)
  })

  it('never queues a badge that was already shown this session', () => {
    expect(mergeQueue([], [unlock('a'), unlock('b')], new Set(['a'])).map(u => u.id)).toEqual(['b'])
  })

  it('ignores malformed input', () => {
    expect(mergeQueue([], null)).toEqual([])
    expect(mergeQueue([], [{}, null])).toEqual([])
  })
})

describe('isBusy', () => {
  const dialog = (hasUnlock) => ({ querySelector: () => (hasUnlock ? {} : null) })
  const doc = dialogs => ({ querySelectorAll: () => dialogs })

  it('waits on the scan screens', () => {
    expect(isBusy(doc([]), '/scans')).toBe(true)
    expect(isBusy(doc([]), '/scans/12')).toBe(true)
    expect(isBusy(doc([]), '/scanner-settings')).toBe(false)
  })

  it('waits while another dialog is open but not for its own sheet', () => {
    expect(isBusy(doc([dialog(false)]), '/')).toBe(true)
    expect(isBusy(doc([dialog(true)]), '/')).toBe(false)
    expect(isBusy(doc([]), '/')).toBe(false)
  })
})
