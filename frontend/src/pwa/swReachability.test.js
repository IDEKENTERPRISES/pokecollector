import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reportReachability, resetReachabilityForTests } from './swReachability'

describe('swReachability', () => {
  const posted = []
  beforeEach(() => {
    vi.useFakeTimers()
    posted.length = 0
    resetReachabilityForTests()
    vi.stubGlobal('navigator', { serviceWorker: { controller: { postMessage: m => posted.push(m) } } })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('posts offline at once', () => {
    reportReachability(true)
    vi.advanceTimersByTime(1)
    expect(posted).toEqual([{ type: 'REACHABILITY', offline: true }])
  })

  it('posts back online only after it has held a few seconds, and a quick offline wins', () => {
    reportReachability(true)
    vi.advanceTimersByTime(1)
    reportReachability(false)
    vi.advanceTimersByTime(1000)
    reportReachability(true)
    vi.advanceTimersByTime(10000)
    expect(posted).toHaveLength(1)
    reportReachability(false)
    vi.advanceTimersByTime(5000)
    expect(posted[1]).toEqual({ type: 'REACHABILITY', offline: false })
  })

  it('does nothing without a controlling worker', () => {
    vi.stubGlobal('navigator', {})
    expect(() => { reportReachability(true); vi.advanceTimersByTime(1) }).not.toThrow()
  })
})
