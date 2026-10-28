import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pendingResults, recordResult } from './daily'
import { flushWtpResults } from './wtpResults'

vi.mock('../api/client', () => ({ postWtpAnswer: vi.fn() }))

beforeEach(() => {
  const data = new Map()
  vi.stubGlobal('localStorage', {
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: k => data.delete(k),
  })
  vi.stubGlobal('navigator', { onLine: true })
})

describe('flushWtpResults', () => {
  it('sends results kept offline once the connection is back, oldest first', async () => {
    recordResult(1, '2026-10-28', { choice: 4, correct: false })
    recordResult(1, '2026-10-27', { choice: 25, correct: true })
    vi.stubGlobal('navigator', { onLine: false })
    const post = vi.fn().mockResolvedValue({})
    expect(await flushWtpResults(1, { post })).toBe(0)
    expect(post).not.toHaveBeenCalled()

    vi.stubGlobal('navigator', { onLine: true })
    expect(await flushWtpResults(1, { post })).toBe(2)
    expect(post.mock.calls).toEqual([['2026-10-27', 25], ['2026-10-28', 4]])
    expect(pendingResults(1)).toEqual([])
  })

  it('keeps a result when the server is unreachable and drops one the server refuses', async () => {
    recordResult(1, '2026-10-27', { choice: 25, correct: true })
    recordResult(1, '2026-10-28', { choice: 4, correct: false })
    const post = vi.fn().mockRejectedValue({ response: { status: 502 } })
    expect(await flushWtpResults(1, { post })).toBe(0)
    expect(pendingResults(1)).toHaveLength(2)

    const refuse = vi.fn().mockRejectedValueOnce({ response: { status: 400 } }).mockResolvedValue({})
    await flushWtpResults(1, { post: refuse })
    expect(pendingResults(1)).toEqual([])
  })
})
