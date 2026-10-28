import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { PREFETCH_CONCURRENCY, buildPrefetchPlan, measure, runPrefetch } from './prefetch.js'

const respond = data => vi.fn(async () => ({ data }))

function fakeClient(overrides = {}) {
  const names = [
    'getCollection', 'getWishlist', 'getBinderCards', 'getDeck', 'getSets',
    'getDashboard', 'getInvestmentTracker', 'getProducts', 'getProductsSummary', 'getCustomCards',
    'getTradeStats', 'getDuplicates', 'getRarityStats', 'getTopMovers', 'getAnalyticsNewSets', 'getAchievements',
  ]
  const client = Object.fromEntries(names.map(name => [name, respond([])]))
  client.getProfile = vi.fn(async () => ({ is_profile_public: false }))
  client.getPokedexSummary = vi.fn(async () => ({ total: 10 }))
  client.getTrades = vi.fn(async () => [])
  client.getBinders = respond([{ id: 1, binder_type: 'collection' }, { id: 2, binder_type: 'deck' }, { id: 3, binder_type: 'wishlist' }])
  client.getDecks = respond([{ id: 2 }, { id: 5 }])
  return Object.assign(client, overrides)
}

const keysOf = queryClient => queryClient.getQueryCache().getAll().map(query => JSON.stringify(query.queryKey))

describe('buildPrefetchPlan', () => {
  const plan = buildPrefetchPlan({ pricePrimaryField: 'market', language: 'en', userId: 7, multiUser: true, client: fakeClient() })
  const ids = plan.map(task => JSON.stringify(task.queryKey))

  it('uses the keys the pages use, including the key the offline owned state reads', () => {
    for (const key of [
      ['collection', {}], ['wishlist'], ['binders'], ['decks'], ['sets', 'all'], ['dashboard', 'market'],
      ['investment-tracker', '1M', 'market'], ['profile'], ['products', 'market'], ['trades'], ['achievements', 7, 'market'],
      ['sets', 'en'], ['collection'], ['deck-picker-collection'], ['collection', 'trades'], ['collection', 'products-linking'],
    ]) expect(ids).toContain(JSON.stringify(key))
  })

  it('puts the collection, wishlist, binders, decks and sets first', () => {
    const firstFive = plan.slice(0, 5).map(task => task.id).sort()
    expect(firstFive).toEqual(['binders', 'collection', 'decks', 'sets-all', 'wishlist'])
  })

  it('plans achievements in single-user mode too', () => {
    const single = buildPrefetchPlan({ pricePrimaryField: 'market', userId: 1, multiUser: false, client: fakeClient() })
    expect(single.some(task => task.queryKey[0] === 'achievements')).toBe(true)
  })

  it('never plans set checklists', () => {
    expect(plan.some(task => ['set-cards', 'set', 'set-detail'].includes(task.queryKey[0]))).toBe(false)
  })

  it('expands binders (not decks) into their contents and decks into each deck, with string ids', async () => {
    const queryClient = new QueryClient()
    await runPrefetch(queryClient, buildPrefetchPlan({ pricePrimaryField: 'market', userId: 7, client: fakeClient() }))
    const keys = keysOf(queryClient)
    expect(keys).toContain(JSON.stringify(['binder-cards', '1', 'market']))
    expect(keys).toContain(JSON.stringify(['binder-cards', '3', 'market']))
    expect(keys).not.toContain(JSON.stringify(['binder-cards', '2', 'market']))
    expect(keys).toContain(JSON.stringify(['deck', '2']))
    expect(keys).toContain(JSON.stringify(['deck', '5']))
  })
})

describe('runPrefetch', () => {
  it('runs two requests at a time', async () => {
    let active = 0
    let peak = 0
    const slow = data => async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active -= 1
      return { data }
    }
    const client = fakeClient()
    for (const name of ['getCollection', 'getWishlist', 'getSets', 'getDashboard', 'getProducts']) client[name] = slow([])
    const queryClient = new QueryClient()
    await runPrefetch(queryClient, buildPrefetchPlan({ userId: 1, client }))
    expect(PREFETCH_CONCURRENCY).toBe(2)
    expect(peak).toBe(2)
  })

  it('does not refetch data that is still fresh', async () => {
    const client = fakeClient()
    const queryClient = new QueryClient()
    await runPrefetch(queryClient, buildPrefetchPlan({ userId: 1, client }))
    const calls = client.getCollection.mock.calls.length
    await runPrefetch(queryClient, buildPrefetchPlan({ userId: 1, client }))
    expect(client.getCollection.mock.calls.length).toBe(calls)
  })

  it('does nothing while offline and stops when asked', async () => {
    const client = fakeClient()
    const queryClient = new QueryClient()
    const offline = await runPrefetch(queryClient, buildPrefetchPlan({ userId: 1, client }), { isOnline: () => false })
    expect(offline.ran).toBe(0)
    expect(client.getCollection).not.toHaveBeenCalled()
    const stopped = await runPrefetch(queryClient, buildPrefetchPlan({ userId: 1, client }), { shouldStop: () => true })
    expect(stopped.ran).toBe(0)
  })

  it('skips a failed request without stopping the rest', async () => {
    const client = fakeClient({ getWishlist: vi.fn(async () => { throw new Error('boom') }) })
    const queryClient = new QueryClient()
    const result = await runPrefetch(queryClient, buildPrefetchPlan({ userId: 1, client }))
    expect(result.skipped).toBeGreaterThan(0)
    expect(queryClient.getQueryData(['binders'])).toBeDefined()
  })

  it("copies the collection under the other pages' keys, within the budget", async () => {
    const big = Array.from({ length: 50 }, (_, i) => ({ id: i, card_id: `c${i}`, note: 'x'.repeat(100) }))
    const client = fakeClient({ getCollection: respond(big) })
    const queryClient = new QueryClient()
    const result = await runPrefetch(queryClient, buildPrefetchPlan({ userId: 1, client }))
    expect(queryClient.getQueryData(['deck-picker-collection'])).toEqual(big)
    expect(queryClient.getQueryData(['collection', 'trades'])).toEqual(big)
    expect(result.bytes).toBeGreaterThan(measure(big) * 4)
  })

  it('keeps the core lists but drops lower tiers once the budget is spent', async () => {
    const big = Array.from({ length: 50 }, (_, i) => ({ id: i, note: 'x'.repeat(100) }))
    const size = measure(big)
    const client = fakeClient({ getCollection: respond(big), getProducts: respond(big) })
    const queryClient = new QueryClient()
    // room for the core lists and the collection once, nothing else big
    const result = await runPrefetch(queryClient, buildPrefetchPlan({ userId: 1, client }), { budget: size * 1.5 })
    expect(queryClient.getQueryData(['collection', {}])).toEqual(big)
    expect(queryClient.getQueryData(['binders'])).toBeDefined()
    expect(queryClient.getQueryData(['products', 'market'])).toBeUndefined()
    expect(queryClient.getQueryData(['deck-picker-collection'])).toBeUndefined()
    expect(result.skipped).toBeGreaterThan(0)
  })
})
