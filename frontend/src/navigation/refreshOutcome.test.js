import { describe, expect, it, vi } from 'vitest'
import {
  REFRESH_CEILING_MS,
  TIMED_OUT,
  activeQueriesFailed,
  looksOffline,
  refreshCeilingMs,
  refreshOutcome,
  reportHealth,
  withTimeout,
} from './refreshOutcome'

describe('looksOffline', () => {
  it('is offline when the device, the sync status or the last probe says so', () => {
    expect(looksOffline({ onLine: false, hookOffline: false, reachabilityState: 'reachable' })).toBe(true)
    expect(looksOffline({ onLine: true, hookOffline: true, reachabilityState: 'reachable' })).toBe(true)
    expect(looksOffline({ onLine: true, hookOffline: false, reachabilityState: 'unreachable' })).toBe(true)
    expect(looksOffline({ onLine: true, hookOffline: false, reachabilityState: 'captive' })).toBe(true)
  })

  it('is not offline when reachable, or when nothing has been probed yet', () => {
    expect(looksOffline({ onLine: true, hookOffline: false, reachabilityState: 'reachable' })).toBe(false)
    expect(looksOffline({ onLine: true, hookOffline: false, reachabilityState: 'unknown' })).toBe(false)
    expect(looksOffline({ onLine: undefined, hookOffline: false, reachabilityState: undefined })).toBe(false)
  })
})

describe('refreshOutcome', () => {
  it('is ok when nothing failed or timed out', () => {
    expect(refreshOutcome({ timedOut: false, anyFailed: false, deviceOnline: true })).toBe('ok')
  })

  it('shows "Offline mode" for a failure or timeout on a device that looks offline', () => {
    expect(refreshOutcome({ timedOut: true, anyFailed: false, deviceOnline: false })).toBe('offline')
    expect(refreshOutcome({ timedOut: false, anyFailed: true, deviceOnline: false })).toBe('offline')
  })

  it('shows "Couldn\'t refresh" for a failure or timeout on a device that looks online', () => {
    expect(refreshOutcome({ timedOut: true, anyFailed: false, deviceOnline: true })).toBe('failed')
    expect(refreshOutcome({ timedOut: false, anyFailed: true, deviceOnline: true })).toBe('failed')
  })
})

describe('withTimeout', () => {
  it('resolves with the value when it is quick', async () => {
    expect(await withTimeout(Promise.resolve('done'), 1000)).toBe('done')
  })

  it('gives up at the ceiling when the promise hangs', async () => {
    vi.useFakeTimers()
    try {
      const pending = withTimeout(new Promise(() => {}), 10_000)
      await vi.advanceTimersByTimeAsync(10_001)
      expect(await pending).toBe(TIMED_OUT)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never rejects: a failing promise resolves undefined', async () => {
    expect(await withTimeout(Promise.reject(new Error('boom')), 1000)).toBeUndefined()
  })
})

describe('activeQueriesFailed', () => {
  const client = queries => ({ getQueryCache: () => ({ findAll: () => queries }) })

  it('is true only for an active query whose last fetch ended in an error', () => {
    expect(activeQueriesFailed(client([{ state: { status: 'error', fetchStatus: 'idle' } }]))).toBe(true)
    expect(activeQueriesFailed(client([{ state: { status: 'success', fetchStatus: 'idle' } }]))).toBe(false)
    expect(activeQueriesFailed(client([{ state: { status: 'error', fetchStatus: 'fetching' } }]))).toBe(false)
    expect(activeQueriesFailed(client([]))).toBe(false)
  })
})

describe('refreshCeilingMs', () => {
  it('defaults to ten seconds and can be shortened through the debug flag', () => {
    expect(REFRESH_CEILING_MS).toBe(10_000)
    expect(refreshCeilingMs({ getItem: () => null })).toBe(10_000)
    expect(refreshCeilingMs({ getItem: () => '1500' })).toBe(1500)
    expect(refreshCeilingMs({ getItem: () => 'nonsense' })).toBe(10_000)
    expect(refreshCeilingMs({ getItem: () => { throw new Error('blocked') } })).toBe(10_000)
  })
})

describe('reportHealth (pull to refresh hands its health check to the shared reachability)', () => {
  it('reports a reachable result so the banner clears', () => {
    const outbox = { reportProbe: vi.fn() }
    const ok = { state: 'reachable', serverInfo: {} }
    reportHealth(outbox, ok)
    expect(outbox.reportProbe).toHaveBeenCalledWith(ok)
  })

  it('reports an unreachable or captive result as it is', () => {
    const outbox = { reportProbe: vi.fn() }
    reportHealth(outbox, { state: 'unreachable' })
    reportHealth(outbox, { state: 'captive' })
    expect(outbox.reportProbe.mock.calls).toEqual([[{ state: 'unreachable' }], [{ state: 'captive' }]])
  })

  it('reports a hanging check (timed out) as unreachable', () => {
    const outbox = { reportProbe: vi.fn() }
    reportHealth(outbox, TIMED_OUT)
    reportHealth(outbox, undefined)
    expect(outbox.reportProbe.mock.calls).toEqual([[{ state: 'unreachable' }], [{ state: 'unreachable' }]])
  })

  it('does nothing without an outbox (the offline queue is off)', () => {
    expect(() => reportHealth(null, { state: 'unreachable' })).not.toThrow()
    expect(() => reportHealth({}, { state: 'unreachable' })).not.toThrow()
  })
})
