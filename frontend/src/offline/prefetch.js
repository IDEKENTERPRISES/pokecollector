// Saves every page's data for offline right after sign-in (F15c). In the background, with the pages' own
// query keys and functions, so the read cache (readCache.js) writes it even for pages never opened.
// Two requests at a time, never blocks anything, skips data that is still fresh, and stays inside the
// read cache's size caps by priority: collection, wishlist, binders, decks and sets first.

import * as api from '../api/client'
import { portfolioApiPeriod } from '../utils/portfolioChart'
import { READ_CACHE_MAX_QUERY_BYTES, READ_CACHE_MAX_TOTAL_BYTES } from './readCache'

const MIB = 1024 * 1024

export const PREFETCH_CONCURRENCY = 2
export const PREFETCH_STALE_MS = 5 * 60 * 1000
// Under the read cache's 50 MiB, so other saved queries (and the head record) still fit.
export const PREFETCH_BUDGET_BYTES = READ_CACHE_MAX_TOTAL_BYTES - 6 * MIB
export const PREFETCH_QUERY_BYTES = READ_CACHE_MAX_QUERY_BYTES

// Tiers: lower runs first. Tier 1 is always kept; the rest only while the total stays inside the budget.
export const TIER = { core: 1, contents: 2, pages: 3, copies: 4 }

const rows = promise => promise.then(response => response.data)
const isDeck = binder => ['deck', 'physical_deck'].includes(binder?.binder_type)

const fetchTask = (id, tier, queryKey, queryFn, expand) => ({ id, tier, queryKey, queryFn, expand })

// The same collection list under the keys other pages read it from (they would otherwise find nothing offline).
const copyTask = (id, queryKey) => ({ id, tier: TIER.copies, queryKey, copyOf: ['collection', {}] })

/**
 * The tasks to run, in order. Binder and deck contents depend on the lists, so those lists' tasks return
 * more tasks (`expand`). `client` defaults to the real API module; tests pass fakes.
 */
export function buildPrefetchPlan({ pricePrimaryField, language, userId, multiUser = false, client = api } = {}) {
  const field = pricePrimaryField || 'market'
  const price = { price_field: field }
  const plan = [
    fetchTask('collection', TIER.core, ['collection', {}], () => rows(client.getCollection({}))),
    fetchTask('wishlist', TIER.core, ['wishlist'], () => rows(client.getWishlist())),
    fetchTask('binders', TIER.core, ['binders'], () => rows(client.getBinders()), binders => (
      (Array.isArray(binders) ? binders : []).filter(binder => !isDeck(binder) && binder.id != null).map(binder => fetchTask(
        `binder-${binder.id}`,
        TIER.contents,
        ['binder-cards', String(binder.id), field],
        () => rows(client.getBinderCards(parseInt(binder.id), price)),
      ))
    )),
    fetchTask('decks', TIER.core, ['decks'], () => rows(client.getDecks()), decks => (
      (Array.isArray(decks) ? decks : []).filter(deck => deck.id != null).map(deck => fetchTask(
        `deck-${deck.id}`,
        TIER.contents,
        ['deck', String(deck.id)],
        () => rows(client.getDeck(deck.id)),
      ))
    )),
    fetchTask('sets-all', TIER.core, ['sets', 'all'], () => rows(client.getSets({ lang: 'all' }))),
    fetchTask('dashboard', TIER.pages, ['dashboard', field], () => rows(client.getDashboard(price))),
    fetchTask('tracker-1m', TIER.pages, ['investment-tracker', '1M', field], () => rows(client.getInvestmentTracker({ period: '1m', ...price }))),
    fetchTask('profile', TIER.pages, ['profile'], () => client.getProfile()),
    fetchTask('pokedex-summary', TIER.pages, ['pokedex-summary'], client.getPokedexSummary),
    fetchTask('products', TIER.pages, ['products', field], () => rows(client.getProducts(price))),
    fetchTask('products-summary', TIER.pages, ['products-summary', field], () => rows(client.getProductsSummary(price))),
    fetchTask('trades', TIER.pages, ['trades'], client.getTrades),
    fetchTask('custom-cards', TIER.pages, ['custom-cards'], () => rows(client.getCustomCards())),
    fetchTask('trade-stats', TIER.pages, ['trade-stats'], () => rows(client.getTradeStats())),
    fetchTask('duplicates', TIER.pages, ['duplicates', field], () => rows(client.getDuplicates(price))),
    fetchTask('rarity-stats', TIER.pages, ['rarity-stats', field], () => rows(client.getRarityStats(price))),
    fetchTask('top-movers', TIER.pages, ['top-movers', 7, field, 'percentage'], () => rows(client.getTopMovers(7, { ...price, sort_by: 'percentage' }))),
    fetchTask('tracker-max', TIER.pages, ['investment-tracker', 'MAX', field], () => rows(client.getInvestmentTracker({ period: portfolioApiPeriod('MAX'), ...price }))),
    fetchTask('new-sets', TIER.pages, ['analytics-new-sets'], () => rows(client.getAnalyticsNewSets())),
    fetchTask('sets-language', TIER.pages, ['sets', language || 'en'], () => rows(client.getSets())),
    copyTask('collection-all', ['collection']),
    copyTask('collection-deck-picker', ['deck-picker-collection']),
    copyTask('collection-trades', ['collection', 'trades']),
    copyTask('collection-products', ['collection', 'products-linking']),
  ]
  if (userId != null) {
    plan.push(fetchTask('achievements', TIER.pages, ['achievements', userId, field], () => rows(client.getAchievements(userId, price))))
  }
  return plan.sort((a, b) => a.tier - b.tier)
}

/** JSON characters of a value; `Infinity` when it cannot be measured. */
export function measure(data) {
  try {
    return JSON.stringify(data)?.length ?? 0
  } catch {
    return Infinity
  }
}

/**
 * Runs the plan on `queryClient`. → `{ ran, skipped, bytes, sizes }`. `isOnline()` and `shouldStop()` are
 * checked before every task. A failed request is just skipped.
 */
export async function runPrefetch(queryClient, plan, {
  concurrency = PREFETCH_CONCURRENCY,
  staleTime = PREFETCH_STALE_MS,
  budget = PREFETCH_BUDGET_BYTES,
  isOnline = () => true,
  shouldStop = () => false,
} = {}) {
  const queue = [...plan]
  const sizes = {}
  const summary = { ran: 0, skipped: 0, bytes: 0, sizes }
  const insert = task => {
    const at = queue.findIndex(other => other.tier > task.tier)
    if (at === -1) queue.push(task)
    else queue.splice(at, 0, task)
  }

  const withinBudget = bytes => summary.bytes + bytes <= budget

  const runTask = async task => {
    const key = task.queryKey
    if (task.copyOf) {
      const source = queryClient.getQueryData(task.copyOf)
      const bytes = sizes[JSON.stringify(task.copyOf)] ?? measure(source)
      if (!Array.isArray(source) || bytes > PREFETCH_QUERY_BYTES || !withinBudget(bytes)) {
        summary.skipped += 1
        return
      }
      if (queryClient.getQueryData(key) === undefined) queryClient.setQueryData(key, source)
      sizes[JSON.stringify(key)] = bytes
      summary.bytes += bytes
      summary.ran += 1
      return
    }
    const held = queryClient.getQueryData(key) !== undefined
    await queryClient.prefetchQuery({ queryKey: key, queryFn: task.queryFn, staleTime, retry: 0 })
    const data = queryClient.getQueryData(key)
    if (data === undefined) {
      summary.skipped += 1
      return
    }
    const bytes = measure(data)
    // Past the caps, only the core lists are kept; the others are dropped again, never the core ones.
    if (task.tier > TIER.core && (bytes > PREFETCH_QUERY_BYTES || !withinBudget(bytes))) {
      if (!held) queryClient.removeQueries({ queryKey: key, exact: true })
      summary.skipped += 1
      return
    }
    sizes[JSON.stringify(key)] = bytes
    summary.bytes += bytes
    summary.ran += 1
    for (const more of task.expand?.(data) ?? []) insert(more)
  }

  const worker = async () => {
    for (;;) {
      if (shouldStop() || !isOnline()) return
      const task = queue.shift()
      if (!task) return
      try {
        await runTask(task)
      } catch {
        summary.skipped += 1
      }
    }
  }

  // A worker that finds the queue empty while another still expands a list would stop early; the expanding
  // tasks are the core lists, which run first, so the second worker is only idle at the very end.
  await Promise.all(Array.from({ length: concurrency }, worker))
  // A task expanded after a worker left (the last core list): drain whatever remains.
  while (queue.length > 0 && !shouldStop() && isOnline()) {
    await Promise.all(Array.from({ length: concurrency }, worker))
  }
  return summary
}
