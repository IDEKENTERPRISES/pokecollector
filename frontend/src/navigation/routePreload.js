// Route chunk preloading. Pages are lazy chunks (App.jsx). Pushing into one that has not loaded yet
// renders the spinner inside the slide transition, so the new page is captured as a spinner and then
// jumps. Starting the import as the finger lands (pointerdown / touchstart), and waiting briefly for it
// before the slide starts, makes the page slide in already drawn. The import specifiers are the same
// ones App.jsx uses, so the module cache is shared and nothing is fetched twice.

const ROUTE_CHUNKS = [
  [/^\/settings(\/|$)/, () => import('../pages/Settings')],
  [/^\/sets\/language\/[^/]+(\/series\/[^/]+)?\/?$/, () => import('../pages/Sets')],
  [/^\/sets\/[^/]+\/?$/, () => import('../pages/SetDetail')],
  [/^\/sets\/?$/, () => import('../pages/SetsLanguages')],
  [/^\/pokedex\/[^/]+\/?$/, () => import('../pages/PokedexSpecies')],
  [/^\/pokedex\/?$/, () => import('../pages/Pokedex')],
  [/^\/binders\/[^/]+\/?$/, () => import('../pages/BinderDetail')],
  [/^\/binders\/?$/, () => import('../pages/Binders')],
  [/^\/wishlist\/?$/, () => import('../pages/Wishlist')],
  [/^\/decks\/compare\/?$/, () => import('../pages/DeckCompare')],
  [/^\/decks\/[^/]+\/?$/, () => import('../pages/DeckEditor')],
  [/^\/analytics\/?$/, () => import('../pages/Analytics')],
  [/^\/dna\/?$/, () => import('../pages/CollectionDna')],
  [/^\/products\/?$/, () => import('../pages/Products')],
  [/^\/trades\/offers\/[^/]+\/?$/, () => import('../pages/SwapOffer')],
  [/^\/trades(\/|$)/, () => import('../pages/Trades')],
  [/^\/leaderboard\/compare\/[^/]+\/?$/, () => import('../pages/Compare')],
  [/^\/leaderboard(\/|$)/, () => import('../pages/Leaderboard')],
  [/^\/goals\/[^/]+\/?$/, () => import('../pages/GoalDetail')],
  [/^\/goals\/?$/, () => import('../pages/Goals')],
  [/^\/achievements(\/|$)/, () => import('../pages/Achievements')],
  [/^\/scans(\/|$)/, () => import('../pages/ScanQueue')],
  [/^\/offline\/?$/, () => import('../pages/OfflineCenter')],
  [/^\/collection\/user\/[^/]+\/?$/, () => import('../pages/UserCollection')],
]

// A chunk that is loaded (or being loaded) is not asked for again; a failed one may be tried again.
const loads = new Map()
const loaded = new Set()

export function pathnameOf(to) {
  if (typeof to === 'string') return to.split('?')[0].split('#')[0]
  return to?.pathname ?? ''
}

export function chunkLoaderFor(pathname, chunks = ROUTE_CHUNKS) {
  return chunks.find(([pattern]) => pattern.test(pathname))?.[1] ?? null
}

/** True when nothing is left to fetch for `to`: the chunk is loaded, or no route chunk matches. */
export function isRouteReady(to, chunks = ROUTE_CHUNKS) {
  const loader = chunkLoaderFor(pathnameOf(to), chunks)
  return !loader || loaded.has(loader)
}

/** Start fetching the page for `to`. Always resolves (a failed fetch is left to the route's own Suspense). */
export function preloadRoute(to, chunks = ROUTE_CHUNKS) {
  const loader = chunkLoaderFor(pathnameOf(to), chunks)
  if (!loader || loaded.has(loader)) return Promise.resolve()
  let promise = loads.get(loader)
  if (!promise) {
    promise = Promise.resolve()
      .then(loader)
      .then(() => { loaded.add(loader) }, () => { loads.delete(loader) })
    loads.set(loader, promise)
  }
  return promise
}

/** Resolves when the page for `to` is loaded, or after `maxMs`, whichever is first. */
export function whenRouteReady(to, maxMs = 400, chunks = ROUTE_CHUNKS) {
  if (isRouteReady(to, chunks)) return Promise.resolve()
  return Promise.race([
    preloadRoute(to, chunks),
    new Promise(resolve => setTimeout(resolve, maxMs)),
  ])
}

export function resetRoutePreloadForTests() {
  loads.clear()
  loaded.clear()
}

export const ROUTE_CHUNK_TABLE = ROUTE_CHUNKS
