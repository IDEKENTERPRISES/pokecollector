import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkIn, localDateString, queueToday, readPending } from './checkin'

vi.mock('../api/client', () => ({ default: { post: vi.fn() } }))

const NOW = new Date(2026, 9, 28, 12, 0, 0)
const key = id => `progress.checkin.pending.${id}`

const memoryStorage = () => {
  const data = new Map()
  return {
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: k => data.delete(k),
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
  vi.stubGlobal('navigator', { onLine: true })
})

afterEach(() => vi.unstubAllGlobals())

describe('queueToday', () => {
  it('queues the local date once per user', () => {
    expect(queueToday(1, NOW)).toEqual(['2026-10-28'])
    expect(queueToday(1, NOW)).toEqual(['2026-10-28'])
    expect(readPending(2)).toEqual([])
  })

  it('drops dates the server would refuse', () => {
    localStorage.setItem(key(1), JSON.stringify(['2026-09-01', '2026-10-20', '2026-11-30', 'junk']))
    expect(queueToday(1, NOW)).toEqual(['2026-10-20', '2026-10-28'])
  })

  it('survives unreadable storage', () => {
    localStorage.setItem(key(1), '{not json')
    expect(queueToday(1, NOW)).toEqual(['2026-10-28'])
  })
})

describe('checkIn', () => {
  it('sends the pending dates with the time zone and clears them on success', async () => {
    localStorage.setItem(key(1), JSON.stringify(['2026-10-26']))
    const client = { post: vi.fn().mockResolvedValue({ data: {} }) }
    await checkIn(1, { now: NOW, client })
    expect(client.post).toHaveBeenCalledWith('/progress/checkin', {
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      dates: ['2026-10-26', '2026-10-28'],
    })
    expect(readPending(1)).toEqual([])
  })

  it('keeps the dates when the request fails and never throws', async () => {
    const client = { post: vi.fn().mockRejectedValue(new Error('network')) }
    await expect(checkIn(1, { now: NOW, client })).resolves.toBeUndefined()
    expect(readPending(1)).toEqual(['2026-10-28'])
  })

  it('drops a batch the server refused with 400', async () => {
    const client = { post: vi.fn().mockRejectedValue({ response: { status: 400 } }) }
    await checkIn(1, { now: NOW, client })
    expect(readPending(1)).toEqual([])
  })

  it('only queues while offline', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const client = { post: vi.fn() }
    await checkIn(1, { now: NOW, client })
    expect(client.post).not.toHaveBeenCalled()
    expect(readPending(1)).toEqual(['2026-10-28'])
  })

  it('ignores a missing user', async () => {
    const client = { post: vi.fn() }
    await checkIn(null, { now: NOW, client })
    expect(client.post).not.toHaveBeenCalled()
  })

  it('does not send the same user twice at once', async () => {
    let release
    const client = { post: vi.fn(() => new Promise(resolve => { release = resolve })) }
    const first = checkIn(1, { now: NOW, client })
    await checkIn(1, { now: NOW, client })
    expect(client.post).toHaveBeenCalledTimes(1)
    release({})
    await first
  })
})

describe('localDateString', () => {
  it('uses the local calendar day', () => {
    expect(localDateString(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
})
