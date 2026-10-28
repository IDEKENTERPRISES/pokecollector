import { describe, expect, it, vi } from 'vitest'
import { fetchPuzzle, isPuzzle, readPuzzle, writePuzzle } from './wtp'
import { ensurePuzzle } from './prefetch'

const memoryStorage = () => {
  const data = new Map()
  return { getItem: k => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) }
}

const puzzle = (date, answer = 25) => ({
  date,
  lang: 'en',
  answer,
  sprite_url: `/api/pokedex/images/artwork/${answer}.png`,
  choices: [{ dex_id: 1, name: 'Bulbasaur' }, { dex_id: answer, name: 'Pikachu' }, { dex_id: 4, name: 'Charmander' }, { dex_id: 7, name: 'Squirtle' }],
})

describe('isPuzzle', () => {
  it('accepts the server shape', () => expect(isPuzzle(puzzle('2026-10-28'))).toBe(true))

  it('rejects a missing answer, a wrong count and a foreign image path', () => {
    expect(isPuzzle({ ...puzzle('2026-10-28'), answer: 150 })).toBe(false)
    expect(isPuzzle({ ...puzzle('2026-10-28'), choices: puzzle('x').choices.slice(0, 3) })).toBe(false)
    expect(isPuzzle({ ...puzzle('2026-10-28'), sprite_url: 'https://evil.example/a.png' })).toBe(false)
    expect(isPuzzle(null)).toBe(false)
  })
})

describe('puzzle storage', () => {
  it('keeps today and the days after, by language', () => {
    const storage = memoryStorage()
    writePuzzle(puzzle('2026-10-27'), storage, '2026-10-28')
    writePuzzle(puzzle('2026-10-28'), storage, '2026-10-28')
    writePuzzle(puzzle('2026-10-29'), storage, '2026-10-28')
    expect(readPuzzle('2026-10-27', 'en', storage)).toBeNull()
    expect(readPuzzle('2026-10-29', 'en', storage)?.answer).toBe(25)
    expect(readPuzzle('2026-10-29', 'de', storage)).toBeNull()
  })
})

describe('fetching', () => {
  const okResponse = body => ({ ok: true, json: async () => body })

  it('returns null offline, on errors and for another date', async () => {
    expect(await fetchPuzzle('2026-10-28', { fetchImpl: vi.fn().mockRejectedValue(new Error('offline')) })).toBeNull()
    expect(await fetchPuzzle('2026-10-28', { fetchImpl: vi.fn().mockResolvedValue({ ok: false }) })).toBeNull()
    expect(await fetchPuzzle('2026-10-28', { fetchImpl: vi.fn().mockResolvedValue(okResponse(puzzle('2026-10-29'))) })).toBeNull()
  })

  it('stores a fetched puzzle only when its image could be cached, and then plays from the device', async () => {
    const storage = memoryStorage()
    const image = { ok: true, headers: { get: () => 'image/png' }, clone() { return this } }
    const fetchImpl = vi.fn(async url => (String(url).startsWith('/api/pokedex/wtp') ? okResponse(puzzle('2026-10-28')) : image))
    const cacheStorage = { open: async () => ({ match: async () => null, put: async () => {} }) }
    const options = { storage, fetchImpl, cacheStorage, now: new Date(2026, 9, 28) }
    expect((await ensurePuzzle('2026-10-28', options))?.answer).toBe(25)
    fetchImpl.mockClear()
    expect((await ensurePuzzle('2026-10-28', options))?.answer).toBe(25)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
