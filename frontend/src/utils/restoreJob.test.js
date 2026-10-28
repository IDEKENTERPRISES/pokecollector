import { describe, expect, test, vi } from 'vitest'

import { RESTORE_POLL_INTERVAL_MS, waitForRestore } from './restoreJob'

const running = { state: 'running', started_at: '2026-10-28T10:00:00+00:00', finished_at: null, error: null }
const done = { ...running, state: 'done', finished_at: '2026-10-28T10:05:00+00:00' }
const failed = { ...running, state: 'failed', error: 'Restore failed: syntax error' }

const statusSequence = (...steps) => {
  const queue = [...steps]
  return vi.fn(async () => {
    const step = queue.shift()
    if (step instanceof Error) throw step
    return step
  })
}

describe('waitForRestore', () => {
  test('polls every 3 seconds while running and stops on done', async () => {
    const fetchStatus = statusSequence(running, running, done)
    const sleep = vi.fn(async () => {})
    const onUpdate = vi.fn()

    const final = await waitForRestore({ fetchStatus, sleep, onUpdate })

    expect(final.state).toBe('done')
    expect(fetchStatus).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(3000)
    expect(RESTORE_POLL_INTERVAL_MS).toBe(3000)
    expect(onUpdate.mock.calls.map(([status]) => status.state)).toEqual(['running', 'running', 'done'])
  })

  test('returns the error text of a failed restore', async () => {
    const final = await waitForRestore({ fetchStatus: statusSequence(running, failed), sleep: async () => {} })
    expect(final).toEqual(failed)
  })

  test('keeps polling through slow or failing status requests', async () => {
    const fetchStatus = statusSequence(new Error('Network Error'), Object.assign(new Error('Bad Gateway'), { response: { status: 504 } }), running, done)
    const final = await waitForRestore({ fetchStatus, sleep: async () => {} })
    expect(final.state).toBe('done')
    expect(fetchStatus).toHaveBeenCalledTimes(4)
  })

  test('gives up after too many consecutive failures', async () => {
    const fetchStatus = vi.fn(async () => { throw new Error('Network Error') })
    await expect(
      waitForRestore({ fetchStatus, sleep: async () => {}, maxFailures: 3 }),
    ).rejects.toThrow('Network Error')
    expect(fetchStatus).toHaveBeenCalledTimes(3)
  })

  test('a successful poll resets the failure count', async () => {
    const error = new Error('Network Error')
    const fetchStatus = statusSequence(error, error, running, error, error, done)
    const final = await waitForRestore({ fetchStatus, sleep: async () => {}, maxFailures: 3 })
    expect(final.state).toBe('done')
  })

  test('stops at once when the session is gone', async () => {
    const unauthorized = Object.assign(new Error('Unauthorized'), { response: { status: 401 } })
    const fetchStatus = statusSequence(running, unauthorized)
    await expect(waitForRestore({ fetchStatus, sleep: async () => {} })).rejects.toBe(unauthorized)
    expect(fetchStatus).toHaveBeenCalledTimes(2)
  })

  test('stops when cancelled', async () => {
    let cancelled = false
    const fetchStatus = vi.fn(async () => running)
    const sleep = vi.fn(async () => { cancelled = true })
    const final = await waitForRestore({ fetchStatus, sleep, isCancelled: () => cancelled })
    expect(final).toBeNull()
    expect(fetchStatus).toHaveBeenCalledTimes(1)
  })
})
