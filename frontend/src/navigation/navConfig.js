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
// `ownBack` marks pages that still render their own back link until their phase migrates them.
export const ROUTES = Object.freeze([
  { path: '/', section: 'home', kind: 'root', titleKey: 'nav.home', offline: true },
  { path: '/collection', section: 'collection', kind: 'root', titleKey: 'nav.collection', offline: true },
  { path: '/binders', section: 'collection', kind: 'root', titleKey: 'nav.collection', label: 'nav.binders', offline: true },
  { path: '/wishlist', section: 'collection', kind: 'root', titleKey: 'nav.collection', offline: true },
  { path: '/binders/:binderId', section: 'collection', kind: 'pushed', parent: '/binders', titleKey: 'nav.binders', offline: true },
  { path: '/decks/compare', section: 'collection', kind: 'pushed', parent: '/binders', titleKey: 'nav.binders', offline: false },
  { path: '/decks/:deckId', section: 'collection', kind: 'pushed', parent: '/binders', titleKey: 'nav.binders', offline: false },
  { path: '/search', section: 'search', kind: 'root', titleKey: 'nav.search', offline: true },
  { path: '/sets', section: 'search', kind: 'pushed', parent: '/search', titleKey: 'nav.sets', offline: true },
  { path: '/sets/series/:seriesKey', section: 'search', kind: 'pushed', parent: '/sets', titleKey: 'nav.sets', offline: true },
  { path: '/sets/:setId', section: 'search', kind: 'pushed', parent: '/sets', titleKey: 'nav.sets', offline: true },
  { path: '/pokedex', section: 'search', kind: 'pushed', parent: '/search', titleKey: 'nav.pokedex', offline: false },
  { path: '/pokedex/:dexId', section: 'search', kind: 'pushed', parent: '/pokedex', titleKey: 'nav.pokedex', offline: false },
  { path: '/scans', section: 'scan', kind: 'pushed', backToPrevious: true, titleKey: 'scanner.queueTitle', offline: false },
  { path: '/scans/:jobId', section: 'scan', kind: 'pushed', parent: '/scans', titleKey: 'scanner.queueTitle', offline: false, ownBack: true },
  { path: '/profile', section: 'profile', kind: 'root', titleKey: 'nav.profile', offline: true },
  { path: '/analytics', section: 'profile', kind: 'pushed', parent: '/profile', titleKey: 'nav.analytics', offline: false },
  { path: '/products', section: 'profile', kind: 'pushed', parent: '/profile', titleKey: 'nav.products', offline: false },
  { path: '/trades', section: 'profile', kind: 'pushed', parent: '/profile', titleKey: 'nav.trades', offline: false },
  { path: '/leaderboard', section: 'profile', kind: 'pushed', parent: '/profile', titleKey: 'nav.leaderboard', offline: false },
  { path: '/leaderboard/compare/:userId', section: 'profile', kind: 'pushed', parent: '/leaderboard', titleKey: 'nav.leaderboard', offline: false, ownBack: true },
  { path: '/collection/user/:userId', section: 'profile', kind: 'pushed', parent: '/leaderboard', titleKey: 'nav.leaderboard', offline: false, ownBack: true },
  { path: '/achievements', section: 'profile', kind: 'pushed', parent: '/profile', titleKey: 'nav.achievements', offline: false },
  { path: '/achievements/:userId', section: 'profile', kind: 'pushed', parent: '/leaderboard', titleKey: 'nav.achievements', offline: false, ownBack: true },
  { path: '/settings', section: 'profile', kind: 'pushed', parent: '/profile', titleKey: 'nav.settings', offline: false },
  { path: '/settings/:section', section: 'profile', kind: 'pushed', parent: '/settings', titleKey: 'nav.settings', offline: false },
  { path: '/offline', section: 'profile', kind: 'pushed', parent: '/profile', titleKey: 'sync.centerTitle', offline: true },
  { path: '/migration', section: 'profile', kind: 'pushed', parent: '/profile', titleKey: 'migration.title', offline: false },
])

/** Routes that only redirect: `to` may reference the params of `path`. */
export const REDIRECTS = Object.freeze([
  { path: '/dashboard', to: '/' },
  { path: '/decks', to: '/binders' },
  { path: '/decks/inventory', to: '/binders' },
  { path: '/decks/:deckId/build', to: '/decks/:deckId' },
])

/** Pages rendered outside the shell: no tab bar and no nav bar. A trailing `/*` matches the whole subtree. */
export const OUTSIDE_SHELL = Object.freeze(['/login', '/u/*', '/__card-system', '/__ios'])

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

export function visibleSettingsSections({ isAdmin = false } = {}) {
  return SETTINGS_SECTIONS.filter(section => !section.adminOnly || isAdmin)
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
  for (const route of ROUTES) {
    const params = matchPattern(route.path, pathname)
    if (params) return { kind: 'route', route, params }
  }
  for (const redirect of REDIRECTS) {
    const params = matchPattern(redirect.path, pathname)
    if (params) return { kind: 'redirect', route: redirect, params }
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

export function isRootPath(pathname) {
  return routeFor(pathname)?.route.kind === 'root'
}

/** The logical parent with route params filled in, or null for roots and "previous screen" routes. */
export function parentForPath(pathname) {
  const match = routeFor(pathname)
  if (!match?.route.parent) return null
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
  { key: 'achievements', to: '/achievements', labelKey: 'nav.achievements', icon: 'Award', multiUser: true },
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
