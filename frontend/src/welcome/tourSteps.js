// The tour's step table (docs/WELCOME_DESIGN.md §3.3, §3.6). Pure, so the social and empty variants are unit-tested.

// The five progress segments, in order. `labelKey` is the section name shown on the hint card.
export const TOUR_SECTIONS = [
  { key: 'home', labelKey: 'nav.home' },
  { key: 'collection', labelKey: 'nav.collection' },
  { key: 'scan', labelKey: 'nav.scan' },
  { key: 'search', labelKey: 'nav.search' },
  { key: 'profile', labelKey: 'nav.profile' },
]

const HOME = 0
const COLLECTION = 1
const SCAN = 2
const SEARCH = 3
const PROFILE = 4

// `route` is the screen a step belongs to (null: any screen); `go` is where the route guard sends a
// trainer who left it, or where Next goes when the following step lives on another screen.
const step = (id, section, target, kind, copy, route = null, go = null, extra = {}) => ({
  id, section, target, kind, copy, route, go, ...extra,
})

/**
 * The steps for this trainer.
 *   social      the swap, feed and challenge features are on (useSocialEnabled)
 *   standalone  running as the Home Screen app (the scan step then asks for notifications)
 *   flags       readPwaFlags(): without `queue` the Sync & offline step is left out
 *   empty       { binders, goals }: nothing to point at, so the + button is shown instead
 */
export function tourSteps({ social = true, standalone = false, flags = {}, empty = {} } = {}) {
  const steps = [
    step('today', HOME, 'today', 'info', 'today', /^\/$/, '/', { maxHeight: 300 }),
  ]
  if (social) {
    steps.push(
      step('challenge-row', HOME, 'challenge-row', 'tap', 'challengeRow', /^\/$/, '/'),
      step('challenge-hero', HOME, 'challenge-hero', 'info', 'challengeHero', /^\/leaderboard\/challenge$/, '/leaderboard/challenge'),
    )
  }
  steps.push(
    step('tab-collection', COLLECTION, 'tab-collection', 'tap', 'tabCollection'),
    step('collection-segments', COLLECTION, 'collection-segments', 'tap', 'collectionSegments', /^\/collection$/, '/collection'),
  )
  if (empty.binders) {
    steps.push(step('new-list', COLLECTION, 'new-list', 'info', 'newList', /^\/binders$/, '/binders'))
  } else {
    steps.push(
      step('first-binder', COLLECTION, 'first-binder', 'tap', 'firstBinder', /^\/binders$/, '/binders'),
      // A binder's id is not known ahead of time: if the trainer left it, the guard skips ahead instead.
      step('view-switch', COLLECTION, 'view-switch', 'tap', 'viewSwitch', /^\/binders\/\d+$/, null),
    )
  }
  steps.push(
    step('tab-scan', SCAN, 'tab-scan', 'tap', 'tabScan'),
    step('shutter', SCAN, 'shutter', 'info', 'shutter'),
    step('scan-queue', SCAN, 'scan-queue', 'tap', 'scanQueue', null, null, { extra: standalone ? 'ask' : 'browser' }),
    step('queue-list', SCAN, 'queue-list', 'info', 'queueList', /^\/scans$/, '/scans'),
    step('tab-search', SEARCH, 'tab-search', 'tap', 'tabSearch'),
    step('search-field', SEARCH, 'search-field', 'info', 'searchField', /^\/search$/, '/search'),
    step('browse-sets', SEARCH, 'browse-sets', 'tap', 'browseSets', /^\/search$/, '/search'),
    step('sets-language', SEARCH, 'sets-language', 'info', 'setsLanguage', /^\/sets(\/|$)/, '/sets'),
    step('tab-profile', PROFILE, 'tab-profile', 'tap', 'tabProfile'),
    step('tile-trades', PROFILE, 'tile-trades', 'tap', social ? 'tileTrades' : 'tileTradesPlain', /^\/profile$/, '/profile'),
    step('trades-offers', PROFILE, 'trades-offers', 'info', social ? 'tradesOffers' : 'tradesPlain', /^\/trades(\/|$)/, '/trades'),
    step('back', PROFILE, 'back', 'tap', 'back', /^\/trades(\/|$)/, '/trades'),
    step('tile-goals', PROFILE, 'tile-goals', 'tap', 'tileGoals', /^\/profile$/, '/profile'),
  )
  if (empty.goals) {
    steps.push(step('new-goal', PROFILE, 'new-goal', 'info', 'newGoal', /^\/goals$/, '/goals'))
  } else {
    steps.push(step('first-goal', PROFILE, 'first-goal', 'info', 'firstGoal', /^\/goals$/, '/goals'))
  }
  if (flags.queue) {
    steps.push(
      step('row-offline', PROFILE, 'row-offline', 'tap', 'rowOffline', /^\/profile$/, '/profile'),
      step('offline-card', PROFILE, 'offline-card', 'info', 'offlineCard', /^\/offline$/, '/offline', { finish: true }),
    )
  } else {
    // Offline features are off: the last step ends the tour (the offline sentence moves to the end card).
    steps[steps.length - 1] = { ...steps[steps.length - 1], finish: true }
  }
  return steps
}

/**
 * Which Home Screen step to show first: 'ios' (iPhone or iPad Safari, not the installed app), 'install' (another
 * browser that has offered an install) or null (already the installed app, or nothing to offer).
 */
export function homeScreenStepKind({ standalone, ios, installable }) {
  if (standalone) return null
  if (ios) return 'ios'
  return installable ? 'install' : null
}

/** Every `data-tour` id the tour may point at (the unit test checks each exists in the source). */
export function allTourTargets() {
  const targets = new Set()
  for (const social of [true, false]) {
    for (const flags of [{ queue: true }, {}]) {
      for (const binders of [true, false]) {
        for (const goals of [true, false]) {
          tourSteps({ social, flags, empty: { binders, goals } }).forEach(item => targets.add(item.target))
        }
      }
    }
  }
  return [...targets]
}
