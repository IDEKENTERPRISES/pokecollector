import { beforeEach, describe, expect, it } from 'vitest'
import {
  markSent, pendingResults, readResults, readShowDaily, recordResult, resultGrid, shareText, shiftDate, writeShowDaily,
} from './daily'

const memoryStorage = () => {
  const data = new Map()
  return {
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: k => data.delete(k),
  }
}

let storage
beforeEach(() => {
  storage = memoryStorage()
})

const t = (key) => ({
  'wtp.shareTitle': "Who's That Pokémon?",
  'wtp.shareWon': 'Got it!',
  'wtp.shareLost': 'Missed it',
  'today.streakDays': '{count}-day streak',
}[key] ?? key)

describe('Show streaks and quests', () => {
  it('is on by default and remembers off', () => {
    expect(readShowDaily(storage)).toBe(true)
    writeShowDaily(false, storage)
    expect(readShowDaily(storage)).toBe(false)
    writeShowDaily(true, storage)
    expect(readShowDaily(storage)).toBe(true)
  })

  it('stays on when storage throws', () => {
    expect(readShowDaily({ getItem: () => { throw new Error('blocked') } })).toBe(true)
  })
})

describe('shiftDate', () => {
  it('crosses month and year boundaries', () => {
    expect(shiftDate('2026-10-01', -1)).toBe('2026-09-30')
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('Who\'s That Pokémon results', () => {
  it('keeps the first answer for a date only', () => {
    recordResult(1, '2026-10-28', { choice: 25, correct: true }, storage)
    recordResult(1, '2026-10-28', { choice: 1, correct: false }, storage)
    expect(readResults(1, storage)['2026-10-28']).toEqual({ choice: 25, correct: true, sent: false })
    expect(readResults(2, storage)).toEqual({})
  })

  it('lists unsent results oldest first and stops listing sent ones', () => {
    recordResult(1, '2026-10-28', { choice: 2, correct: false }, storage)
    recordResult(1, '2026-10-27', { choice: 3, correct: true }, storage)
    expect(pendingResults(1, storage).map(r => r.date)).toEqual(['2026-10-27', '2026-10-28'])
    markSent(1, '2026-10-27', storage)
    expect(pendingResults(1, storage).map(r => r.date)).toEqual(['2026-10-28'])
  })

  it('ignores damaged storage', () => {
    storage.setItem('pc.wtp.results.1', '{"2026-10-28":{"choice":"x"}}')
    expect(readResults(1, storage)).toEqual({})
    storage.setItem('pc.wtp.results.1', 'nope')
    expect(readResults(1, storage)).toEqual({})
  })
})

describe('share text', () => {
  const results = {
    '2026-10-24': { choice: 1, correct: true },
    '2026-10-26': { choice: 1, correct: false },
    '2026-10-28': { choice: 1, correct: true },
  }

  it('draws the last seven days', () => {
    expect(Array.from(resultGrid(results, '2026-10-28'))).toEqual(['⬜', '⬜', '🟩', '⬜', '🟥', '⬜', '🟩'])
  })

  it('has a title, the grid with the verdict, and the streak when there is one', () => {
    const text = shareText({ t, date: '2026-10-28', results, streak: 12 })
    expect(text.split('\n')).toEqual([
      "Who's That Pokémon? 2026-10-28",
      '⬜⬜🟩⬜🟥⬜🟩 Got it!',
      '🔥 12-day streak',
    ])
    expect(shareText({ t, date: '2026-10-26', results, streak: 0 })).toContain('Missed it')
    expect(shareText({ t, date: '2026-10-26', results, streak: 0 })).not.toContain('🔥')
  })
})
