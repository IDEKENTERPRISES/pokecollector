import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/client', () => ({
  setTutorialDone: vi.fn(),
  clearTutorialDone: vi.fn(),
}))

import { clearTutorialDone, setTutorialDone } from '../api/client'
import { isNewAccount, readLocalDone, recordTourDone, resetTourDone, syncTourDone, tourIsDone } from './tourStorage'

function memoryStorage() {
  const map = new Map()
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
  }
}

const user = { id: 7, username: 'ash' }
const DAY = 24 * 3600 * 1000

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('localStorage', memoryStorage())
})

describe('isNewAccount', () => {
  it('is true for an account made in the last two days and false for older or unknown ones', () => {
    const now = Date.parse('2026-11-03T12:00:00Z')
    expect(isNewAccount({ created_at: new Date(now - DAY).toISOString() }, now)).toBe(true)
    expect(isNewAccount({ created_at: new Date(now - 3 * DAY).toISOString() }, now)).toBe(false)
    expect(isNewAccount({}, now)).toBe(false)
    expect(isNewAccount(null, now)).toBe(false)
  })
})

describe('tourIsDone', () => {
  it('is done on the server, or by the copy on this device', () => {
    expect(tourIsDone(user)).toBe(false)
    expect(tourIsDone({ ...user, tutorial_completed_at: '2026-11-01T10:00:00' })).toBe(true)
    localStorage.setItem('pc.tour.done.7', JSON.stringify({ outcome: 'skipped', at: 'x', synced: false }))
    expect(tourIsDone(user)).toBe(true)
    expect(tourIsDone(null)).toBe(true)
  })

  it('survives a broken local copy', () => {
    localStorage.setItem('pc.tour.done.7', '{nope')
    expect(readLocalDone(7)).toBeNull()
    expect(tourIsDone(user)).toBe(false)
  })
})

describe('recordTourDone', () => {
  it('writes locally at once and sends the outcome with the time it happened', async () => {
    setTutorialDone.mockResolvedValue({ tutorial_completed_at: '2026-11-03T10:00:00', tutorial_outcome: 'finished' })
    const onUser = vi.fn()
    await recordTourDone(user, 'finished', onUser, new Date('2026-11-03T10:00:00Z'))
    expect(setTutorialDone).toHaveBeenCalledWith('finished', '2026-11-03T10:00:00.000Z')
    expect(readLocalDone(7)).toMatchObject({ outcome: 'finished', synced: true })
    expect(onUser).toHaveBeenLastCalledWith({ tutorial_completed_at: '2026-11-03T10:00:00', tutorial_outcome: 'finished' })
  })

  it('keeps an unsent completion when offline, so the tour does not repeat, and sends it later', async () => {
    setTutorialDone.mockRejectedValueOnce(new Error('offline'))
    await recordTourDone(user, 'skipped', vi.fn(), new Date('2026-11-03T10:00:00Z'))
    expect(readLocalDone(7)).toMatchObject({ outcome: 'skipped', synced: false })
    expect(tourIsDone(user)).toBe(true)
    setTutorialDone.mockResolvedValueOnce({ tutorial_completed_at: '2026-11-03T10:00:00', tutorial_outcome: 'skipped' })
    expect(await syncTourDone(user, vi.fn())).toBe(true)
    expect(readLocalDone(7).synced).toBe(true)
    expect(await syncTourDone(user, vi.fn())).toBe(false) // nothing left to send
    expect(setTutorialDone).toHaveBeenCalledTimes(2)
  })
})

describe('resetTourDone', () => {
  it('clears the server and the local copy', async () => {
    clearTutorialDone.mockResolvedValue({})
    localStorage.setItem('pc.tour.done.7', JSON.stringify({ outcome: 'finished', at: 'x', synced: true }))
    const onUser = vi.fn()
    await resetTourDone(user, onUser)
    expect(clearTutorialDone).toHaveBeenCalled()
    expect(readLocalDone(7)).toBeNull()
    expect(onUser).toHaveBeenCalledWith({ tutorial_completed_at: null, tutorial_outcome: null })
  })

  it('keeps the local copy when the server cannot be reached', async () => {
    clearTutorialDone.mockRejectedValue(new Error('offline'))
    localStorage.setItem('pc.tour.done.7', JSON.stringify({ outcome: 'finished', at: 'x', synced: true }))
    await expect(resetTourDone(user)).rejects.toThrow()
    expect(readLocalDone(7)).not.toBeNull()
  })
})
