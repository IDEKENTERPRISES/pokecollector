import { setBackPath } from '../utils/setsLanguage.js'

// Single source for the shell (design doc §2, §4): the tab bar, the desktop sidebar, the highlighted
// tab of each route, the Profile rows and the back targets all read this file. Routes are mapped
// explicitly by pattern, never by prefix: `/collection/user/:userId` belongs to Profile even though
// it starts with `/collection`.

/** The four tabs; the Scan circle between Collection and Search is an overlay, not a route. */
export const TABS = Object.freeze([
  { key: 'home', root: '/', labelKey: 'nav.home' },
  { key: 'collection', root: '/collection', labelKey: 'nav.collection' },
  { key: 'search', root: '/search', labelKey: 'nav.search' },
  { key: 'profile', root: '/profile', labelKey: 'nav.profile' },
])

export const SCAN_SECTION = 'scan'

// kind: 'root' (a tab root, large title) or 'pushed'. `parent` is the logical back target;
// `backToPrevious` sends the user to the previous screen instead (the scan inbox). `label` is the
// key used when the route is a back target (defaults to titleKey): `/binders` reads "Card Lists".
// Every page opens offline (offline/routes.js), so rows carry no offline flag.
// `ownBack` marks pages that still render their own back link until their phase migrates them.
export const ROUTES = Object.freeze([
  { path: '/', section: 'home', kind: 'root', titleKey: 'nav.home' },
  { path: '/collection', section: 'collection', kind: 'root', titleKey: 'nav.collection' },
  { path: '/binders', section: 'collection', kind: 'root', titleKey: 'nav.collection', label: 'nav.binders' },
  { path: '/wishlist', section: 'collection', kind: 'root', titleKey: 'nav.collection' },
  { path: '/binders/:binderId', section: 'collection', kind: 'pushed', parent: '/binders', titleKey: 'nav.binders' },
  { path: '/decks/compare', section: 'collection', kind: 'pushed', parent: '/binders', titleKey: 'nav.binders' },
  { path: '/decks/:deckId', section: 'collection', kind: 'pushed', parent: '/binders', titleKey: 'nav.binders' },
  { path: '/search', section: 'search', kind: 'root', titleKey: 'nav.search' },
  // `instant`: a push into it never slides. These open a long list of a language's series (or redirect to
  // it), and WebKit crashes capturing a page that tall as a transition picture.
  { path: '/sets', section: 'search', kind: 'pushed', parent: '/search', titleKey: 'nav.sets', instant: true },
  { path: '/sets/language/:lang', section: 'search', kind: 'pushed', parent: '/sets', titleKey: 'nav.sets', instant: true },
  { path: '/sets/language/:lang/series/:seriesKey', section: 'search', kind: 'pushed', parent: '/sets/language/:lang', titleKey: 'nav.sets' },
  // Old series links (redirected into their language); kept so the shell treats them as Sets meanwhile.
  { path: '/sets/series/:seriesKey', section: 'search', kind: 'pushed', parent: '/sets', titleKey: 'nav.sets' },
  { path: '/sets/:setId', section: 'search', kind: 'pushed', parent: '/sets', titleKey: 'nav.sets' },
  { path: '/pokedex', section: 'search', kind: 'pushed', parent: '/search', titleKey: 'nav.pokedex' },
  { path: '/pokedex/:dexId', section: 'search', kind: 'pushed', parent: '/pokedex', titleKey: 'nav.pokedex' },
  { path: '/scans', section: 'scan', kind: 'pushed', backToPrevious: true, titleKey: 'scanner.queueTitle' },
  { path: '/scans/:jobId', section: 'scan', kind: 'pushed', parent: '/scans', titleKey: 'scanner.queueTitle' },
  { path: '/profile', section: 'profile', kind: 'root', titleKey: 'nav.profile' },
  { path: '/analytics', section: 'profile', kind: 'pushed', parent: '/profile', titleKey: 'nav.analytics' },
  { path: '/dna', section: 'profile', kind: 'pushed', parent: '/profile', titleKey: 'delights.dna' },
  { path: '/products', section: 'profile', kind: 'pushed', parent: '/profile', titleKey: 'nav.products' },
  { path: '/trades', section: 'profile', kind: 'pushed', parent: '/profile', titleKey: 'nav.trades' },
  { path: '/leaderboard', section: 'profile', kind: 'pushed', parent: '/profile', titleKey: 'nav.leaderboard' },
  { path: '/leaderboard/compare/:userId', section: 'profile', kind: 'pushed', parent: '/leaderboard', titleKey: 'nav.leaderboard' },
  { path: '/collection/user/:userId', section: 'profile', kind: 'pushed', parent: '/leaderboard', titleKey: 'nav.leaderboard' },
  { path: '/achievements', section: 'profile', kind: 'pushed', parent: '/profile', titleKey: 'nav.achievements' },
  { path: '/achievements/:userId', section: 'profile', kind: 'pushed', parent: '/leaderboard', titleKey: 'nav.achievements' },
  { path: '/settings', section: 'profile', kind: 'pushed', parent: '/profile', titleKey: 'nav.settings' },
  { path: '/settings/:section', section: 'profile', kind: 'pushed', parent: '/settings', titleKey: 'nav.settings' },
  { path: '/offline', section: 'profile', kind: 'pushed', parent: '/profile', titleKey: 'sync.centerTitle' },
  { path: '/migration', section: 'profile', kind: 'pushed', parent: '/profile', titleKey: 'migration.title' },
])

/** Routes that only redirect: `to` may reference the params of `path`. */
export const REDIRECTS = Object.freeze([
  { path: '/dashboard', to: '/' },
  { path: '/decks', to: '/binders' },
  { path: '/decks/inventory', to: '/binders' },
  { path: '/decks/:deckId/build', to: '/decks/:deckId' },
])

/** Pages rendered outside the shell: no tab bar and no nav bar. A trailing `/*` matches the whole subtree. */
export const OUTSIDE_SHELL = Object.freeze(['/login', '/invite/*', '/u/*', '/__card-system', '/__ios', '/__splash'])

/** Settings sections (design doc §5.6), in display order. Hidden sections are left out, never disabled. */
export const SETTINGS_SECTIONS = Object.freeze([
  { key: 'account', titleKey: 'settings.sections.account', icon: 'User', colour: '#0A84FF' },
  { key: 'appearance', titleKey: 'settings.sections.appearance', icon: 'Palette', colour: '#BF5AF2' },
  { key: 'scanner', titleKey: 'settings.sections.scanner', icon: 'ScanLine', colour: '#30D158' },
  { key: 'notifications', titleKey: 'settings.sections.notifications', icon: 'Bell', colour: '#FF453A' },
  { key: 'data', titleKey: 'settings.sections.data', icon: 'Database', colour: '#FF9F0A', adminOnly: true },
  { key: 'users', titleKey: 'settings.sections.users', icon: 'Users', colour: '#64D2FF', adminOnly: true },
  { key: 'community', titleKey: 'settings.sections.community', icon: 'Heart', colour: '#FF375F' },
  { key: 'about', titleKey: 'settings.sections.about', icon: 'Info', colour: '#8E8E93' },
])

/**
 * `scannerManaged`: an administrator sets the scanner for everyone (SCANNER_GLOBAL_CONFIG) and this
 * user is not one, so the Scanner section is not theirs to see.
 */
export function visibleSettingsSections({ isAdmin = false, scannerManaged = false } = {}) {
  return SETTINGS_SECTIONS.filter(section => (
    (!section.adminOnly || isAdmin) && !(scannerManaged && section.key === 'scanner')
  ))
}

export function settingsSection(key) {
  return SETTINGS_SECTIONS.find(section => section.key === key) ?? null
}

function splitPath(pathname) {
  return String(pathname ?? '').split('?')[0].split('#')[0].split('/').filter(Boolean)
}

/** Match `pathname` against one pattern. Returns the params or null. A trailing slash is ignored. */
export function matchPattern(pattern, pathname) {
  if (pattern.endsWith('/*')) {
    const base = pattern.slice(0, -2)
    const path = String(pathname ?? '')
    return path === base || path.startsWith(`${base}/`) ? {} : null
  }
  const wanted = splitPath(pattern)
  const actual = splitPath(pathname)
  if (wanted.length !== actual.length) return null
  const params = {}
  for (let i = 0; i < wanted.length; i += 1) {
    if (wanted[i].startsWith(':')) {
      try {
        params[wanted[i].slice(1)] = decodeURIComponent(actual[i])
      } catch {
        params[wanted[i].slice(1)] = actual[i]
      }
    } else if (wanted[i] !== actual[i]) {
      return null
    }
  }
  return params
}

export function fillPattern(pattern, params = {}) {
  const filled = pattern.replace(/:([A-Za-z]+)/g, (_, name) => encodeURIComponent(params[name] ?? ''))
  return filled || '/'
}

/** → `{ kind: 'route' | 'redirect' | 'outside', route, params }`, or null for an unknown path. */
export function matchRoute(pathname) {
  // Redirects first: `/decks/inventory` is a redirect, not a deck whose id is "inventory".
  for (const redirect of REDIRECTS) {
    const params = matchPattern(redirect.path, pathname)
    if (params) return { kind: 'redirect', route: redirect, params }
  }
  for (const route of ROUTES) {
    const params = matchPattern(route.path, pathname)
    if (params) return { kind: 'route', route, params }
  }
  for (const pattern of OUTSIDE_SHELL) {
    const params = matchPattern(pattern, pathname)
    if (params) return { kind: 'outside', route: { path: pattern }, params }
  }
  return null
}

function routeFor(pathname) {
  const match = matchRoute(pathname)
  return match?.kind === 'route' ? match : null
}

/** 'home' | 'collection' | 'search' | 'profile' | 'scan', or null outside the shell and for unknown paths. */
export function sectionForPath(pathname) {
  return routeFor(pathname)?.route.section ?? null
}

/** The highlighted tab, or null (the scan inbox highlights the Scan circle instead). */
export function tabForPath(pathname) {
  const section = sectionForPath(pathname)
  return TABS.some(tab => tab.key === section) ? section : null
}

export function isOutsideShell(pathname) {
  return matchRoute(pathname)?.kind === 'outside'
}

/** A route one level into a tab (a detail, a section, a series), where a slide transition fits. */
export function isPushedPath(pathname) {
  return routeFor(pathname)?.route.kind === 'pushed'
}

/** A pushed route that opens without the slide (see `instant` in ROUTES). */
export function isInstantPath(pathname) {
  return Boolean(routeFor(pathname)?.route.instant)
}

export function isRootPath(pathname) {
  return routeFor(pathname)?.route.kind === 'root'
}

/** The logical parent with route params filled in, or null for roots and "previous screen" routes. */
export function parentForPath(pathname) {
  const match = routeFor(pathname)
  if (!match?.route.parent) return null
  // A set goes back to its language's set list (the id ends in the language: sv1_ja).
  if (match.route.path === '/sets/:setId') return setBackPath(match.params.setId)
  return fillPattern(match.route.parent, match.params)
}

export function sectionRoot(section) {
  return TABS.find(tab => tab.key === section)?.root ?? '/'
}

/** The compact title key; `/settings/:section` uses the section's own title. */
export function titleKeyForPath(pathname) {
  const match = routeFor(pathname)
  if (!match) return null
  if (match.route.path === '/settings/:section') {
    return settingsSection(match.params.section)?.titleKey ?? match.route.titleKey
  }
  return match.route.titleKey
}

/** The key a back button uses for the page at `pathname`: the page's label, else its title. */
export function labelKeyForPath(pathname) {
  const match = routeFor(pathname)
  if (!match) return null
  return match.route.label ?? titleKeyForPath(pathname)
}

/** The text a back button shows for the page at `pathname`: its parent's label. */
export function backLabelKeyForPath(pathname) {
  const parent = parentForPath(pathname)
  return parent ? labelKeyForPath(parent) : null
}

export function isOwnBack(pathname) {
  return Boolean(routeFor(pathname)?.route.ownBack)
}

export function goesBackToPrevious(pathname) {
  return Boolean(routeFor(pathname)?.route.backToPrevious)
}

/**
 * Profile destinations (design doc §5.5): the tiles, the list rows and the desktop sidebar read
 * this. `multiUser` hides a row in single-user mode, `queue` hides it while the offline queue is off.
 */
export const PROFILE_LINKS = Object.freeze([
  { key: 'analytics', to: '/analytics', labelKey: 'nav.analytics', icon: 'BarChart3' },
  { key: 'products', to: '/products', labelKey: 'nav.products', icon: 'Package' },
  { key: 'trades', to: '/trades', labelKey: 'nav.trades', icon: 'ArrowLeftRight' },
  { key: 'leaderboard', to: '/leaderboard', labelKey: 'nav.leaderboard', icon: 'Trophy', multiUser: true },
  { key: 'achievements', to: '/achievements', labelKey: 'nav.achievements', icon: 'Award' },
  { key: 'settings', to: '/settings', labelKey: 'nav.settings', icon: 'Settings' },
  { key: 'sync', to: '/offline', labelKey: 'profile.syncOffline', icon: 'RefreshCw', queue: true },
])

/** The desktop sidebar's tree (§6.13): tabs with the destinations under them. */
export const SIDEBAR_CHILDREN = Object.freeze({
  collection: [
    { to: '/collection', labelKey: 'nav.cards' },
    { to: '/binders', labelKey: 'nav.binders' },
    { to: '/wishlist', labelKey: 'nav.wishlist' },
  ],
  search: [
    { to: '/sets', labelKey: 'nav.sets' },
    { to: '/pokedex', labelKey: 'nav.pokedex' },
  ],
})
