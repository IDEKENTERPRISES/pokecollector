import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  READ_CACHE_DB_NAME,
  READ_CACHE_DENY,
  READ_CACHE_MAX_AGE_MS,
  READ_CACHE_MAX_QUERY_BYTES,
  READ_CACHE_HEAD_QUERY_BYTES,
  READ_CACHE_HEAD_TOTAL_BYTES,
  READ_CACHE_MAX_TOTAL_BYTES,
  applyCaps,
  applyFirst,
  buildRecords,
  headKey,
  holdsSecret,
  isSavableKey,
  persist,
  purge,
  purgeAll,
  purgeOthers,
  readFirst,
  recordKey,
  restore,
  restoreMissing,
} from './readCache.js'

const origin = 'https://pokes.test'
let indexedDB
let client

const openRaw = () => {
  const request = indexedDB.open(READ_CACHE_DB_NAME, 1)
  request.onupgradeneeded = () => request.result.createObjectStore('qc')
  return request
}

const getRecord = key => new Promise((resolve, reject) => {
  const open = openRaw()
  open.onsuccess = () => {
    const db = open.result
    const request = db.transaction('qc').objectStore('qc').get(key)
    request.onsuccess = () => { db.close(); resolve(request.result) }
    request.onerror = () => reject(request.error)
  }
  open.onerror = () => reject(open.error)
})

const putRaw = (key, value) => new Promise((resolve, reject) => {
  const open = openRaw()
  open.onsuccess = () => {
    const db = open.result
    const tx = db.transaction('qc', 'readwrite')
    tx.objectStore('qc').put(value, key)
    tx.oncomplete = () => { db.close(); resolve() }
    tx.onerror = () => reject(tx.error)
  }
})

const keysOf = () => new Promise((resolve, reject) => {
  const open = openRaw()
  open.onsuccess = () => {
    const db = open.result
    const request = db.transaction('qc').objectStore('qc').getAllKeys()
    request.onsuccess = () => { db.close(); resolve(request.result.sort()) }
    request.onerror = () => reject(request.error)
  }
})

const newClient = () => new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
const seed = (queryKey, data) => client.setQueryData(queryKey, data)
const save = (userId = 1) => persist(client, { origin, userId, indexedDB, throttleMs: 5000 }).flush()
const hashes = record => record.state.queries.map(query => query.queryHash).sort()

beforeEach(() => {
  indexedDB = new IDBFactory()
  client = newClient()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('read cache', () => {
  it('saves successful queries of every page except the deny list', async () => {
    seed(['collection', { page: 1 }], [{ id: 1 }])
    seed(['wishlist'], [{ id: 2 }])
    seed(['profile'], { name: 'x' })
    seed(['pokedex', 'en'], { entries: [] })
    seed(['analytics', 'duplicates'], [{ id: 5 }])
    seed(['users'], [{ id: 9 }])
    seed(['invites'], [{ id: 3 }])
    seed(['audit-log', 25], { pages: [] })
    await client.fetchQuery({ queryKey: ['dashboard'], queryFn: () => { throw new Error('boom') }, retry: false }).catch(() => {})
    await save()
    const record = await getRecord(recordKey(origin, 1))
    expect(record.v).toBe(1)
    expect(record.state.queries.map(query => query.queryKey[0]).sort()).toEqual(['analytics', 'collection', 'pokedex', 'profile', 'wishlist'])
  })

  it('restores into a fresh client and returns savedAt', async () => {
    seed(['collection'], [{ id: 1 }, { id: 2 }])
    await save()
    const other = newClient()
    const savedAt = await restore(other, { origin, userId: 1, indexedDB })
    expect(typeof savedAt).toBe('number')
    expect(other.getQueryData(['collection'])).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('namespaces records by origin and user', async () => {
    seed(['collection'], ['mine'])
    await save(1)
    const other = newClient()
    expect(await restore(other, { origin, userId: 2, indexedDB })).toBeNull()
    expect(await restore(other, { origin: 'https://else.test', userId: 1, indexedDB })).toBeNull()
    expect(other.getQueryData(['collection'])).toBeUndefined()
  })

  it('drops a query over 5 MiB and keeps the rest', async () => {
    seed(['collection'], 'x'.repeat(READ_CACHE_MAX_QUERY_BYTES + 10))
    seed(['wishlist'], ['ok'])
    await save()
    expect(hashes(await getRecord(recordKey(origin, 1)))).toEqual(['["wishlist"]'])
  })

  it('drops the oldest queries until the total fits in 50 MiB', () => {
    const big = 'x'.repeat(12 * 1024 * 1024)
    const queries = [1, 2, 3, 4, 5, 6].map(n => ({ queryHash: `q${n}`, state: { data: big, dataUpdatedAt: n } }))
    const kept = applyCaps(queries).map(query => query.queryHash).sort()
    expect(kept).toHaveLength(4)
    expect(kept).not.toContain('q1')
    expect(kept).not.toContain('q2')
    expect(READ_CACHE_MAX_TOTAL_BYTES).toBe(50 * 1024 * 1024)
  })

  describe('deny list', () => {
    it('keeps invite links, the audit log, admin lists, sessions, scanner configuration and push out', () => {
      for (const key of ['invites', 'audit-log', 'users', 'user-sessions', 'sessions', 'scanner-configuration', 'push', 'push-subscription', 'telegram-status', 'setting', 'feed']) {
        expect(isSavableKey([key]), key).toBe(false)
        expect(READ_CACHE_DENY.has(key)).toBe(true)
      }
    })

    it('keeps live-state and blob queries out', () => {
      for (const key of ['sync-status', 'scan-jobs', 'scan-job', 'collection-photo']) expect(isSavableKey([key, 3]), key).toBe(false)
    })

    it('saves the pages: collection, sets, decks, Pokédex, analytics, products, trades, leaderboard, profile', () => {
      for (const key of ['collection', 'sets', 'set-checklist', 'binders', 'binder-cards', 'decks', 'deck', 'pokedex', 'analytics', 'duplicates', 'top-movers', 'rarity-stats', 'products', 'trades', 'leaderboard', 'achievements', 'profile', 'dashboard', 'wishlist']) {
        expect(isSavableKey([key, 'x']), key).toBe(true)
      }
    })

    it('keeps a query out when a key part names a secret', () => {
      expect(isSavableKey(['settings-page', 'telegram_bot_token'])).toBe(false)
      expect(isSavableKey(['collection', 'api_key'])).toBe(false)
      expect(isSavableKey(['reset-password-form'])).toBe(false)
    })

    it('ignores empty and non-string first keys', () => {
      expect(isSavableKey([])).toBe(false)
      expect(isSavableKey([{ a: 1 }])).toBe(false)
      expect(isSavableKey(undefined)).toBe(false)
    })

    it('spots a secret field in the data, and drops that query from the record', async () => {
      expect(holdsSecret(JSON.stringify({ items: [{ name: 'x', access_token: 'abc' }] }))).toBe(true)
      expect(holdsSecret(JSON.stringify({ user: { password: 'x' } }))).toBe(true)
      expect(holdsSecret(JSON.stringify({ gemini_api_key: 'x' }))).toBe(true)
      expect(holdsSecret(JSON.stringify({ name: 'a token of appreciation' }))).toBe(false)
      seed(['collection'], [{ id: 1 }])
      seed(['products'], [{ id: 1, client_secret: 'shh' }])
      await save()
      expect(hashes(await getRecord(recordKey(origin, 1)))).toEqual(['["collection"]'])
    })

    it('never restores a denied query that an older record held', async () => {
      seed(['collection'], ['ok'])
      await save()
      const record = await getRecord(recordKey(origin, 1))
      record.state.queries.push({ queryHash: '["invites"]', queryKey: ['invites'], state: { ...record.state.queries[0].state, data: [{ token: 'x' }] } })
      await putRaw(recordKey(origin, 1), record)
      const other = newClient()
      await restore(other, { origin, userId: 1, indexedDB })
      expect(other.getQueryData(['invites'])).toBeUndefined()
    })
  })

  it('keeps saved pages that were not opened this session', async () => {
    seed(['collection'], ['old'])
    await save()
    client = newClient()
    seed(['wishlist'], ['new'])
    await save()
    expect(hashes(await getRecord(recordKey(origin, 1)))).toEqual(['["collection"]', '["wishlist"]'])
  })

  describe('mid-session restore (restoreMissing)', () => {
    it('puts back saved queries this session does not hold', async () => {
      seed(['collection'], [{ id: 1 }])
      seed(['wishlist'], [{ id: 2 }])
      await save()
      const session = newClient()
      const result = await restoreMissing(session, { origin, userId: 1, indexedDB })
      expect(result.restored).toBe(2)
      expect(typeof result.savedAt).toBe('number')
      expect(session.getQueryData(['collection'])).toEqual([{ id: 1 }])
      expect(session.getQueryData(['wishlist'])).toEqual([{ id: 2 }])
    })

    it('never overwrites data this session already holds, even when the saved copy is newer', async () => {
      seed(['collection'], ['saved'])
      await save()
      const session = newClient()
      session.setQueryData(['collection'], ['this session'], { updatedAt: Date.now() - 60_000 })
      const result = await restoreMissing(session, { origin, userId: 1, indexedDB })
      expect(result.restored).toBe(0)
      expect(session.getQueryData(['collection'])).toEqual(['this session'])
    })

    it('fills a query that is pending with no data', async () => {
      seed(['collection'], ['saved'])
      await save()
      const session = newClient()
      session.getQueryCache().build(session, { queryKey: ['collection'] }) // mounted, nothing fetched yet
      expect((await restoreMissing(session, { origin, userId: 1, indexedDB })).restored).toBe(1)
      expect(session.getQueryData(['collection'])).toEqual(['saved'])
    })

    it('returns nothing without a usable record (none, other user, other version)', async () => {
      const session = newClient()
      expect(await restoreMissing(session, { origin, userId: 1, indexedDB })).toEqual({ savedAt: null, restored: 0 })
      seed(['collection'], ['x'])
      await save(1)
      expect((await restoreMissing(newClient(), { origin, userId: 2, indexedDB })).restored).toBe(0)
      const record = await getRecord(recordKey(origin, 1))
      await putRaw(recordKey(origin, 1), { ...record, appVersion: 'other-build' })
      expect((await restoreMissing(newClient(), { origin, userId: 1, indexedDB })).restored).toBe(0)
    })

    it('never throws without IndexedDB', async () => {
      expect(await restoreMissing(newClient(), { origin, userId: 1, indexedDB: null })).toEqual({ savedAt: null, restored: 0 })
    })

    it('does not let restored (older) data replace a newer saved record', async () => {
      seed(['collection'], ['v1'])
      await save()
      const first = await getRecord(recordKey(origin, 1))
      const session = newClient()
      await restoreMissing(session, { origin, userId: 1, indexedDB }) // this tab now holds v1
      // Another tab saves a newer record in the meantime.
      const newer = structuredClone(first)
      newer.state.queries[0].state.data = ['v2']
      newer.state.queries[0].state.dataUpdatedAt = first.state.queries[0].state.dataUpdatedAt + 60_000
      await putRaw(recordKey(origin, 1), newer)
      // This tab's persister now writes: the restored v1 must not win.
      await persist(session, { origin, userId: 1, indexedDB, throttleMs: 5000 }).flush()
      const after = await getRecord(recordKey(origin, 1))
      expect(after.state.queries.find(query => query.queryHash === '["collection"]').state.data).toEqual(['v2'])
    })
  })

  it('a fresh result replaces an older saved copy of the same query', async () => {
    seed(['collection'], ['old'])
    await save()
    client = newClient()
    seed(['collection'], ['new'])
    await save()
    const record = await getRecord(recordKey(origin, 1))
    expect(record.state.queries.find(query => query.queryHash === '["collection"]').state.data).toEqual(['new'])
  })

  it('ignores a record from another app version', async () => {
    seed(['collection'], ['x'])
    await save()
    const record = await getRecord(recordKey(origin, 1))
    await putRaw(recordKey(origin, 1), { ...record, appVersion: 'other-build' })
    expect(await restore(newClient(), { origin, userId: 1, indexedDB })).toBeNull()
  })

  it('ignores a record older than 30 days', async () => {
    seed(['collection'], ['x'])
    await save()
    const later = Date.now() + READ_CACHE_MAX_AGE_MS + 1000
    expect(await restore(newClient(), { origin, userId: 1, indexedDB, now: later })).toBeNull()
  })

  it('ignores corrupted records', async () => {
    for (const bad of ['text', 42, { v: 1 }, { v: 2, savedAt: Date.now(), appVersion: '', state: { queries: [] } }, { v: 1, savedAt: Date.now(), appVersion: '', state: {} }]) {
      await putRaw(recordKey(origin, 1), bad)
      const target = newClient()
      expect(await restore(target, { origin, userId: 1, indexedDB })).toBeNull()
      expect(target.getQueryCache().getAll()).toHaveLength(0)
    }
  })

  it('purge removes one record, purgeOthers keeps only the given user, purgeAll clears', async () => {
    seed(['collection'], ['x'])
    await save(1)
    await save(2)
    await save(3)
    await purge({ origin, userId: 1, indexedDB })
    expect(await keysOf()).toEqual([recordKey(origin, 2), headKey(origin, 2), recordKey(origin, 3), headKey(origin, 3)].sort())
    await purgeOthers({ origin, keepUserId: 3, indexedDB })
    expect(await keysOf()).toEqual([recordKey(origin, 3), headKey(origin, 3)].sort())
    await purgeAll({ indexedDB })
    expect(await keysOf()).toEqual([])
  })

  it('writes through a 5 s trailing throttle after successful results', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const persister = persist(client, { origin, userId: 1, indexedDB, throttleMs: 5000 })
    await vi.advanceTimersByTimeAsync(6000)
    expect(await getRecord(recordKey(origin, 1))).toBeUndefined() // nothing fetched yet
    client.setQueryData(['collection'], ['x'])
    await client.fetchQuery({ queryKey: ['wishlist'], queryFn: async () => ['y'] })
    await vi.advanceTimersByTimeAsync(4000)
    expect(await getRecord(recordKey(origin, 1))).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1500)
    await vi.waitFor(async () => expect(await getRecord(recordKey(origin, 1))).toBeDefined())
    await persister.stop()
    expect(hashes(await getRecord(recordKey(origin, 1)))).toEqual(['["collection"]', '["wishlist"]'])
  })

  it('stop() cancels a pending write so a purge is not undone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const persister = persist(client, { origin, userId: 1, indexedDB, throttleMs: 5000 })
    await client.fetchQuery({ queryKey: ['collection'], queryFn: async () => ['x'] })
    await persister.stop()
    await purge({ origin, userId: 1, indexedDB })
    await vi.advanceTimersByTimeAsync(10000)
    expect(await getRecord(recordKey(origin, 1))).toBeUndefined()
  })

  it('does nothing and never throws without IndexedDB', async () => {
    seed(['collection'], ['x'])
    await expect(restore(client, { origin, userId: 1, indexedDB: null })).resolves.toBeNull()
    await expect(persist(client, { origin, userId: 1, indexedDB: null }).flush()).resolves.toBe(false)
    await expect(purge({ origin, userId: 1, indexedDB: null })).resolves.toBeUndefined()
    await expect(purgeOthers({ origin, keepUserId: 1, indexedDB: null })).resolves.toBe(0)
    await expect(purgeAll({ indexedDB: null })).resolves.toBeUndefined()
  })
})

describe('cold-start restore (head record)', () => {
  const big = () => 'x'.repeat(READ_CACHE_HEAD_QUERY_BYTES + 10)

  it('writes the small queries to a head record next to the full one', async () => {
    seed(['dashboard'], { a: 1 })
    seed(['collection', { page: 1 }], [big()])
    await save()
    const head = await getRecord(headKey(origin, 1))
    const full = await getRecord(recordKey(origin, 1))
    expect(head.state.queries.map(query => query.queryKey[0])).toEqual(['dashboard'])
    expect(full.state.queries.map(query => query.queryKey[0]).sort()).toEqual(['collection', 'dashboard'])
  })

  it('keeps the head within its total size, newest first', () => {
    const now = Date.now()
    for (let i = 0; i < 40; i += 1) {
      client.setQueryData(['page', i], ['y'.repeat(200 * 1024)], { updatedAt: now + i })
    }
    const { head, record } = buildRecords(client, null)
    expect(record.state.queries).toHaveLength(40)
    expect(head.state.queries.length).toBeLessThan(40)
    expect(head.state.queries.length * 200 * 1024).toBeLessThanOrEqual(READ_CACHE_HEAD_TOTAL_BYTES)
    expect(head.state.queries[0].queryKey).toEqual(['page', 39])
  })

  it('readFirst reads only the head, applyFirst hydrates it and says the rest is missing', async () => {
    seed(['dashboard'], { a: 1 })
    seed(['collection'], [big()])
    await save()
    const other = newClient()
    const first = await readFirst({ origin, userId: 1, indexedDB })
    expect(first.complete).toBe(false)
    const { savedAt, complete } = applyFirst(other, first)
    expect(typeof savedAt).toBe('number')
    expect(complete).toBe(false)
    expect(other.getQueryData(['dashboard'])).toEqual({ a: 1 })
    expect(other.getQueryData(['collection'])).toBeUndefined()
    // The rest follows by merge.
    const rest = await restoreMissing(other, { origin, userId: 1, indexedDB })
    expect(rest.restored).toBe(1)
    expect(other.getQueryData(['collection'])).toEqual([big()])
  })

  it('falls back to the whole record when no head was written yet', async () => {
    seed(['collection'], [{ id: 1 }])
    await save()
    const { record } = buildRecords(client, null)
    await putRaw(recordKey(origin, 7), record)
    const first = await readFirst({ origin, userId: 7, indexedDB })
    expect(first.complete).toBe(true)
    const other = newClient()
    expect(applyFirst(other, first).complete).toBe(true)
    expect(other.getQueryData(['collection'])).toEqual([{ id: 1 }])
  })

  it('returns nothing usable for no record, a stale version or a missing database', async () => {
    expect(await readFirst({ origin, userId: 1, indexedDB })).toEqual({ record: null, complete: true })
    expect(applyFirst(newClient(), { record: null, complete: true })).toEqual({ savedAt: null, complete: true })
    expect(await readFirst({ origin, userId: 1, indexedDB: undefined })).toEqual({ record: null, complete: true })
  })
})
