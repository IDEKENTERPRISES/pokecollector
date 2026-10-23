import { describe, expect, it, vi } from 'vitest'
import { PictureError, retrying, statusError, timed } from './net.js'
import {
  cardPictureUrl, createPictureRecord, downloadPictures, inspectPictureSets, packPath, parsePack, setPictureUrl,
} from './pictures.js'
import { buildPack } from './packFixture.js'
import { AbortedError } from './sync.js'

const memoryStorage = () => {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) }
}

const fakeCache = () => {
  const entries = new Map()
  return { entries, match: async url => entries.get(url), put: async (url, response) => { entries.set(url, response) } }
}

const setPayload = (id, cardIds, { logo = true } = {}) => ({
  set: { id, images_logo: logo ? 'l' : null, images_symbol: null },
  fields: ['id', 'images_small'],
  cards: cardIds.map(card => [card, 'x.webp']),
})

const imageResponse = (size = 4) => ({ status: 200, headers: { get: () => 'image/webp' }, blob: async () => new Blob([new Uint8Array(size)]) })
const instant = () => Promise.resolve()

function harness(overrides = {}) {
  const cache = fakeCache()
  const record = createPictureRecord(memoryStorage(), 'en')
  const fetchPack = vi.fn(async path => {
    const setId = decodeURIComponent(path.split('/').pop())
    const payload = overrides.sets?.find(item => item.set.id === setId)
    const ids = payload.cards.map(row => row[0])
    return { status: 200, buffer: buildPack(ids.map(id => ({ id, bytes: new Uint8Array([1, 2, 3, 4, 5]) }))) }
  })
  const fetchImage = vi.fn(async () => imageResponse())
  const options = { lang: 'en', cache, record, fetchPack, fetchImage, sleep: instant, retries: 3, ...overrides }
  return { cache, record, fetchPack, fetchImage, options }
}

describe('parsePack', () => {
  it('reads the index and the bytes', () => {
    const parsed = parsePack(buildPack([{ id: 'a-1', bytes: new Uint8Array([9, 8]) }, { id: 'a-2', type: 'image/png', bytes: new Uint8Array([7]) }], ['a-3']))
    expect(parsed.items.map(item => [item.id, item.type, [...item.bytes]])).toEqual([['a-1', 'image/webp', [9, 8]], ['a-2', 'image/png', [7]]])
    expect(parsed.missing).toEqual(['a-3'])
  })
})

describe('downloadPictures', () => {
  const sets = [setPayload('a_en', ['a-1', 'a-2']), setPayload('b_en', ['b-1'])]

  it('unpacks a pack into one cache entry per picture under the worker URL and fetches the set logo singly', async () => {
    const { cache, record, fetchPack, fetchImage, options } = harness({ sets })
    const progress = []
    await downloadPictures({ ...options, sets, onProgress: p => progress.push(p) })
    expect(fetchPack.mock.calls.map(call => call[0]).sort()).toEqual([packPath('en', 'a_en'), packPath('en', 'b_en')])
    expect([...cache.entries.keys()].sort()).toEqual([
      cardPictureUrl('a-1'), cardPictureUrl('a-2'), cardPictureUrl('b-1'), setPictureUrl('a_en', 'logo'), setPictureUrl('b_en', 'logo'),
    ].sort())
    expect(fetchImage).toHaveBeenCalledTimes(2) // only the two logos
    expect(record.doneCount()).toBe(2)
    expect(progress.at(-1)).toMatchObject({ doneSets: 2, totalSets: 2 })
    expect(progress.at(-1).bytes).toBeGreaterThan(10)
  })

  it('fetches the pictures a pack lists as missing one by one', async () => {
    const { cache, fetchImage, options } = harness({ sets })
    options.fetchPack.mockImplementation(async () => ({ status: 200, buffer: buildPack([{ id: 'a-1', bytes: new Uint8Array(3) }], ['a-2']) }))
    await downloadPictures({ ...options, sets: [sets[0]] })
    expect(fetchImage.mock.calls.map(call => call[0]).sort()).toEqual([cardPictureUrl('a-2'), setPictureUrl('a_en', 'logo')].sort())
    expect(cache.entries.has(cardPictureUrl('a-2'))).toBe(true)
  })

  it('falls back to single pictures when the server has no packs', async () => {
    const { cache, options } = harness({ sets })
    options.fetchPack.mockResolvedValue({ status: 404 })
    await downloadPictures({ ...options, sets: [sets[0]] })
    expect(cache.entries.size).toBe(3)
  })

  it('never stores the card-back redirect the server answers for a picture it could not fetch', async () => {
    const { cache, record, options } = harness({ sets })
    options.fetchPack.mockResolvedValue({ status: 404 })
    options.fetchImage.mockResolvedValue({ status: 200, redirected: true, headers: { get: () => 'image/jpeg' }, blob: async () => new Blob(['x']) })
    await downloadPictures({ ...options, sets: [sets[0]] })
    expect(cache.entries.size).toBe(0)
    expect(record.skipped()).toBe(3)
  })

  it('resumes: finished sets are not requested again, also from a record saved by an earlier run', async () => {
    const storage = memoryStorage()
    const first = harness({ sets })
    first.options.record = createPictureRecord(storage, 'en')
    first.options.fetchPack.mockImplementation(async path => {
      if (path.endsWith('/b_en')) throw statusError(401)
      return { status: 200, buffer: buildPack([{ id: 'a-1', bytes: new Uint8Array(2) }, { id: 'a-2', bytes: new Uint8Array(2) }]) }
    })
    await expect(downloadPictures({ ...first.options, sets, concurrency: 1 })).rejects.toBeInstanceOf(PictureError)

    // "app restart": a new record over the same storage, the same cache
    const record = createPictureRecord(storage, 'en')
    expect(record.isDone('a_en')).toBe(true)
    const fetchPack = vi.fn(async () => ({ status: 200, buffer: buildPack([{ id: 'b-1', bytes: new Uint8Array(2) }]) }))
    await downloadPictures({ ...first.options, record, fetchPack, sets })
    expect(fetchPack.mock.calls.map(call => call[0])).toEqual([packPath('en', 'b_en')])
    expect(record.doneCount()).toBe(2)
  })

  it('stops a stalled request with a timeout, retries it, then fails with the reason "timeout"', async () => {
    const { options } = harness({ sets })
    options.fetchPack.mockImplementation(() => new Promise(() => {})) // a hanging request that ignores its signal
    const error = await downloadPictures({ ...options, sets: [sets[0]], packTimeoutMs: 15, retries: 2 }).catch(caught => caught)
    expect(error).toBeInstanceOf(PictureError)
    expect(error.reason).toBe('timeout')
    expect(options.fetchPack).toHaveBeenCalledTimes(2)
  })

  it('retries a server error with backoff and then succeeds', async () => {
    const { options } = harness({ sets })
    const waits = []
    let calls = 0
    options.fetchPack.mockImplementation(async () => {
      calls += 1
      if (calls < 3) throw statusError(503)
      return { status: 200, buffer: buildPack([{ id: 'b-1', bytes: new Uint8Array(1) }]) }
    })
    await downloadPictures({ ...options, sets: [sets[1]], sleep: async ms => { waits.push(ms) } })
    expect(calls).toBe(3)
    expect(waits).toEqual([1000, 2000])
  })

  it('does not retry a 401', async () => {
    const { options } = harness({ sets })
    options.fetchPack.mockRejectedValue(statusError(401))
    const error = await downloadPictures({ ...options, sets: [sets[0]] }).catch(caught => caught)
    expect(error.reason).toBe('auth')
    expect(options.fetchPack).toHaveBeenCalledTimes(1)
  })

  it('a failure aborts the other lanes and nothing keeps running after it rejects', async () => {
    const many = ['a', 'b', 'c', 'd'].map(letter => setPayload(`${letter}_en`, [`${letter}-1`]))
    const { options } = harness({ sets: many })
    let inFlight = 0
    options.fetchPack.mockImplementation((path, signal) => new Promise((resolve, reject) => {
      inFlight += 1
      const finish = fn => value => { inFlight -= 1; fn(value) }
      if (path.endsWith('/a_en')) setTimeout(finish(reject), 5, new PictureError('network'))
      else signal.addEventListener('abort', () => finish(reject)(new Error('aborted')))
    }))
    await expect(downloadPictures({ ...options, sets: many, concurrency: 3, retries: 1 })).rejects.toMatchObject({ reason: 'network' })
    expect(inFlight).toBe(0)
  })

  it('pausing rejects with AbortedError even while a request hangs', async () => {
    const { options } = harness({ sets })
    options.fetchPack.mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const run = downloadPictures({ ...options, sets, signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    await expect(run).rejects.toBeInstanceOf(AbortedError)
  })

  it('reports a full or blocked storage as the reason "storage"', async () => {
    const { cache, options } = harness({ sets })
    cache.put = async () => { throw new Error('QuotaExceededError') }
    const error = await downloadPictures({ ...options, sets: [sets[0]] }).catch(caught => caught)
    expect(error.reason).toBe('storage')
  })
})

describe('inspectPictureSets', () => {
  it('counts sets whose pictures are all cached (an earlier download) and remembers them', async () => {
    const cache = fakeCache()
    const record = createPictureRecord(memoryStorage(), 'en')
    const sets = [setPayload('a_en', ['a-1']), setPayload('b_en', ['b-1'])]
    for (const url of [cardPictureUrl('a-1'), setPictureUrl('a_en', 'logo')]) cache.entries.set(url, {})
    const result = await inspectPictureSets({ sets, cache, record })
    expect(result).toMatchObject({ doneSets: 1, totalSets: 2, remainingUrls: 2 })
    expect(record.isDone('a_en')).toBe(true)
  })
})

describe('timed and retrying', () => {
  it('timed rejects with a timeout and aborts the inner signal', async () => {
    let innerSignal
    await expect(timed(signal => { innerSignal = signal; return new Promise(() => {}) }, 10)).rejects.toMatchObject({ reason: 'timeout' })
    expect(innerSignal.aborted).toBe(true)
  })

  it('retrying gives up after the attempts and passes the last error on', async () => {
    const fn = vi.fn(async () => { throw new PictureError('server') })
    await expect(retrying(fn, { attempts: 3, sleep: instant })).rejects.toMatchObject({ reason: 'server' })
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
