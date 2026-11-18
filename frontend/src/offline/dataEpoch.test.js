import { describe, expect, it, vi } from 'vitest'
import {
  DATA_EPOCH_KEY, guardProbeWithEpoch, judgeEpoch, observeDataEpoch, onDataWiped, readStoredEpoch, startDataEpochWatch,
  wipeLocalData,
} from './dataEpoch'
import { probe } from './outbox/probe'

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)) },
    removeItem: key => { data.delete(key) },
    clear: () => data.clear(),
    keys: () => [...data.keys()],
  }
}

describe('judgeEpoch', () => {
  it('does nothing when the server sends no epoch', () => {
    expect(judgeEpoch('a', null)).toBe('unknown')
    expect(judgeEpoch('a', undefined)).toBe('unknown')
    expect(judgeEpoch(null, '')).toBe('unknown')
  })

  it('remembers the first epoch it sees', () => {
    expect(judgeEpoch(null, 'a')).toBe('first')
  })

  it('tells a wipe from no change', () => {
    expect(judgeEpoch('a', 'a')).toBe('same')
    expect(judgeEpoch('a', 'b')).toBe('wiped')
  })
})

describe('wipeLocalData', () => {
  it('drops the outbox, clears every stored preference, keeps only the new epoch and goes to login', async () => {
    const storage = memoryStorage({ token: 't', user: '{}', lastUser: 'ash', theme: 'dark', [DATA_EPOCH_KEY]: 'old' })
    const session = memoryStorage({ 'pokecollector:list-scroll:/sets': '10' })
    const order = []
    const clearAll = vi.fn(async options => { order.push('clearAll'); expect(options).toEqual({ keepOutbox: false }) })
    const redirect = vi.fn(() => { order.push('redirect') })
    const listener = vi.fn(async () => { order.push('listener') })

    await wipeLocalData('new', { storage, session, clearAll, redirect, extraListeners: new Set([listener]) })

    expect(order).toEqual(['listener', 'clearAll', 'redirect'])
    expect(storage.keys()).toEqual([DATA_EPOCH_KEY])
    expect(readStoredEpoch(storage)).toBe('new')
    expect(session.keys()).toEqual([])
  })

  it('still removes the token and logs out when a cleanup step fails', async () => {
    const storage = memoryStorage({ token: 't', [DATA_EPOCH_KEY]: 'old' })
    const redirect = vi.fn()
    await wipeLocalData('new', {
      storage,
      session: memoryStorage(),
      clearAll: async () => { throw new Error('indexeddb blocked') },
      redirect,
      extraListeners: new Set([async () => { throw new Error('listener failed') }]),
    })
    expect(storage.getItem('token')).toBeNull()
    expect(redirect).toHaveBeenCalledTimes(1)
  })
})

describe('observeDataEpoch', () => {
  const options = (storage, extra = {}) => ({
    storage, session: memoryStorage(), clearAll: vi.fn(async () => {}), redirect: vi.fn(), extraListeners: new Set(), ...extra,
  })

  it('stores the first epoch and leaves the device alone', async () => {
    const storage = memoryStorage({ token: 't' })
    const opts = options(storage)
    expect(await observeDataEpoch('a', opts)).toBe('first')
    expect(readStoredEpoch(storage)).toBe('a')
    expect(storage.getItem('token')).toBe('t')
    expect(opts.clearAll).not.toHaveBeenCalled()
  })

  it('leaves the device alone when the epoch is the same or unknown', async () => {
    const storage = memoryStorage({ token: 't', [DATA_EPOCH_KEY]: 'a' })
    const opts = options(storage)
    expect(await observeDataEpoch('a', opts)).toBe('same')
    expect(await observeDataEpoch(null, opts)).toBe('unknown')
    expect(storage.getItem('token')).toBe('t')
    expect(opts.redirect).not.toHaveBeenCalled()
  })

  it('wipes a phone that was offline during the wipe when it next reaches the server', async () => {
    const storage = memoryStorage({ token: 'old', user: '{"id":5}', [DATA_EPOCH_KEY]: 'before' })
    const opts = options(storage)
    expect(await observeDataEpoch('after', opts)).toBe('wiped')
    expect(opts.clearAll).toHaveBeenCalledWith({ keepOutbox: false })
    expect(storage.getItem('token')).toBeNull()
    expect(readStoredEpoch(storage)).toBe('after')
    expect(opts.redirect).toHaveBeenCalledTimes(1)
    // the same server answer later is just "same": no second wipe, no login loop
    expect(await observeDataEpoch('after', opts)).toBe('same')
    expect(opts.clearAll).toHaveBeenCalledTimes(1)
  })

  it('runs the cleanup once when several callers see the new epoch at the same time', async () => {
    const storage = memoryStorage({ [DATA_EPOCH_KEY]: 'before' })
    const opts = options(storage)
    await Promise.all([observeDataEpoch('after', opts), observeDataEpoch('after', opts)])
    expect(opts.clearAll).toHaveBeenCalledTimes(1)
  })

  it('runs registered cleanup (the outbox stops before its database is deleted)', async () => {
    const storage = memoryStorage({ [DATA_EPOCH_KEY]: 'before' })
    const stop = vi.fn()
    const off = onDataWiped(stop)
    const opts = options(storage)
    delete opts.extraListeners
    await observeDataEpoch('after', opts)
    off()
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

describe('guardProbeWithEpoch', () => {
  it('turns a probe into "unreachable" when the server was wiped, so nothing is replayed', async () => {
    const inner = vi.fn(async () => ({ state: 'reachable', serverInfo: { dataEpoch: 'after' } }))
    const observe = vi.fn(async () => 'wiped')
    expect(await guardProbeWithEpoch(inner, observe)()).toEqual({ state: 'unreachable' })
    expect(observe).toHaveBeenCalledWith('after')
  })

  it('passes a normal probe through and skips the check when unreachable', async () => {
    const reachable = { state: 'reachable', serverInfo: { dataEpoch: 'a' } }
    expect(await guardProbeWithEpoch(async () => reachable, async () => 'same')()).toBe(reachable)
    const observe = vi.fn()
    const down = { state: 'unreachable' }
    expect(await guardProbeWithEpoch(async () => down, observe)()).toBe(down)
    expect(observe).not.toHaveBeenCalled()
  })
})

describe('startDataEpochWatch', () => {
  it('checks at start and when the connection returns, and stops cleanly', async () => {
    const handlers = {}
    const target = {
      addEventListener: (name, fn) => { handlers[name] = fn },
      removeEventListener: name => { delete handlers[name] },
      document: { visibilityState: 'visible', addEventListener: (name, fn) => { handlers[name] = fn }, removeEventListener: name => { delete handlers[name] } },
    }
    const probeFn = vi.fn(async () => ({ state: 'reachable', serverInfo: { dataEpoch: 'x' } }))
    const observe = vi.fn(async () => 'same')
    const stop = startDataEpochWatch({ probe: probeFn, observe, target })
    await Promise.resolve()
    await Promise.resolve()
    expect(observe).toHaveBeenCalledWith('x')
    await handlers.online()
    expect(probeFn).toHaveBeenCalledTimes(2)
    stop()
    expect(Object.keys(handlers)).toEqual([])
  })
})

describe('the health probe', () => {
  const answer = body => async () => ({
    status: 200, type: 'basic', headers: { get: () => 'application/json' }, json: async () => body,
  })
  const base = { status: 'ok', service: 'pokemon-tcg-collection', version: '1', api_level: 1, features: [] }

  it('reads data_epoch into the server info', async () => {
    const result = await probe({ fetchImpl: answer({ ...base, data_epoch: 'abc' }), debug: () => false })
    expect(result.serverInfo.dataEpoch).toBe('abc')
  })

  it('has no epoch from an older server', async () => {
    const result = await probe({ fetchImpl: answer(base), debug: () => false })
    expect(result.serverInfo.dataEpoch).toBeNull()
  })
})
