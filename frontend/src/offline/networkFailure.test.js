import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SLOW_REQUEST_HINT_MS,
  endSlowRequestHint,
  notifyNetworkFailure,
  onNetworkFailure,
  startSlowRequestHint,
} from './networkFailure'

describe('network failure bus', () => {
  it('tells every listener and survives one that throws', () => {
    const good = vi.fn()
    const offBad = onNetworkFailure(() => { throw new Error('listener bug') })
    const offGood = onNetworkFailure(good)
    expect(() => notifyNetworkFailure()).not.toThrow()
    expect(good).toHaveBeenCalledTimes(1)
    offBad()
    offGood()
    notifyNetworkFailure()
    expect(good).toHaveBeenCalledTimes(1)
  })
})

describe('slow request hint', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('hints after about five seconds without an answer, once', () => {
    const notify = vi.fn()
    const config = {}
    startSlowRequestHint(config, { notify })
    vi.advanceTimersByTime(SLOW_REQUEST_HINT_MS - 1)
    expect(notify).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(notify).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('stays quiet for a request that answers in time (the hint is cancelled, the request is not)', () => {
    const notify = vi.fn()
    const config = {}
    startSlowRequestHint(config, { notify })
    vi.advanceTimersByTime(1000)
    endSlowRequestHint(config)
    vi.advanceTimersByTime(60_000)
    expect(notify).not.toHaveBeenCalled()
    expect(config.__slowRequestHint).toBeNull()
  })

  it('ends safely for a config that never started one', () => {
    expect(() => endSlowRequestHint({})).not.toThrow()
    expect(() => endSlowRequestHint(undefined)).not.toThrow()
    expect(() => startSlowRequestHint(undefined, { notify: vi.fn() })).not.toThrow()
  })
})
