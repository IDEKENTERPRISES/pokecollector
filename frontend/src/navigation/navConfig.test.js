import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { OFFLINE_ROUTES, isOfflineRoute } from '../offline/routes.js'
import en from '../i18n/en.js'
import {
  OUTSIDE_SHELL,
  REDIRECTS,
  ROUTES,
  SETTINGS_SECTIONS,
  TABS,
  backLabelKeyForPath,
  isOwnBack,
  isRootPath,
  matchPattern,
  matchRoute,
  parentForPath,
  sectionForPath,
  tabForPath,
  titleKeyForPath,
  visibleSettingsSections,
} from './navConfig.js'

const here = dirname(fileURLToPath(import.meta.url))
const appSource = readFileSync(resolve(here, '..', 'App.jsx'), 'utf8')

// Route paths declared in App.jsx, as full patterns. ProtectedRoutes' paths are relative to "/",
// the public routes to "/u"; the dev galleries and /login are top-level.
function declaredPaths() {
  const paths = new Set()
  const protectedStart = appSource.indexOf('function ProtectedRoutes')
  const appStart = appSource.indexOf('export default function App')
  const protectedBlock = appSource.slice(protectedStart, appStart)
  const appBlock = appSource.slice(appStart)
  const publicStart = appBlock.indexOf('<Route path="/u"')
  const publicEnd = appBlock.indexOf('</Route>', publicStart)

  for (const match of protectedBlock.matchAll(/<Route\s+(index|path="([^"]*)")/g)) {
    if (match[1] === 'index') paths.add('/')
    else if (match[2] !== '/' && match[2] !== '*') paths.add(`/${match[2]}`)
  }
  for (const match of appBlock.slice(0, publicStart).matchAll(/<Route\s+path="([^"]*)"/g)) {
    if (match[1] !== '/*') paths.add(match[1])
  }
  paths.add('/u')
  for (const match of appBlock.slice(publicStart, publicEnd).matchAll(/<Route\s+path="([^"/][^"]*)"/g)) {
    paths.add(`/u/${match[1]}`)
  }
  return paths
}

describe('navConfig against App.jsx', () => {
  const declared = declaredPaths()

  it('finds the routes it expects in App.jsx', () => {
    expect(declared.has('/collection')).toBe(true)
    expect(declared.has('/sets/series/:seriesKey')).toBe(true)
    expect(declared.has('/settings/:section')).toBe(true)
    expect(declared.has('/u/:handle')).toBe(true)
    expect(declared.has('/')).toBe(true)
  })

  it('maps every declared path to a ROUTES, REDIRECTS or OUTSIDE_SHELL entry', () => {
    const known = new Set([...ROUTES.map(r => r.path), ...REDIRECTS.map(r => r.path)])
    for (const path of declared) {
      const inShell = known.has(path)
      const outside = OUTSIDE_SHELL.some(pattern => matchPattern(pattern, path.replace(/:[A-Za-z]+/g, 'x')))
      expect({ path, mapped: inShell || outside }).toEqual({ path, mapped: true })
    }
  })

  it('declares every ROUTES and REDIRECTS pattern in App.jsx', () => {
    for (const { path } of [...ROUTES, ...REDIRECTS]) {
      expect({ path, declared: declared.has(path) }).toEqual({ path, declared: true })
    }
  })

  it('redirects unknown paths to /', () => {
    expect(appSource).toMatch(/<Route path="\*" element=\{<Navigate to="\/" replace \/>\} \/>/)
  })
})

describe('navConfig table (design doc §4.2)', () => {
  const rows = [
    ['/', 'home', 'root', null, 'nav.home'],
    ['/collection', 'collection', 'root', null, 'nav.collection'],
    ['/binders', 'collection', 'root', null, 'nav.collection'],
    ['/wishlist', 'collection', 'root', null, 'nav.collection'],
    ['/binders/7', 'collection', 'pushed', '/binders', 'nav.binders'],
    ['/decks/12', 'collection', 'pushed', '/binders', 'nav.binders'],
    ['/decks/compare', 'collection', 'pushed', '/binders', 'nav.binders'],
    ['/search', 'search', 'root', null, 'nav.search'],
    ['/sets', 'search', 'pushed', '/search', 'nav.sets'],
    ['/sets/series/base', 'search', 'pushed', '/sets', 'nav.sets'],
    ['/sets/base1', 'search', 'pushed', '/sets', 'nav.sets'],
    ['/pokedex', 'search', 'pushed', '/search', 'nav.pokedex'],
    ['/pokedex/25', 'search', 'pushed', '/pokedex', 'nav.pokedex'],
    ['/scans', 'scan', 'pushed', null, 'scanner.queueTitle'],
    ['/scans/9', 'scan', 'pushed', '/scans', 'scanner.queueTitle'],
    ['/profile', 'profile', 'root', null, 'nav.profile'],
    ['/analytics', 'profile', 'pushed', '/profile', 'nav.analytics'],
    ['/products', 'profile', 'pushed', '/profile', 'nav.products'],
    ['/trades', 'profile', 'pushed', '/profile', 'nav.trades'],
    ['/leaderboard', 'profile', 'pushed', '/profile', 'nav.leaderboard'],
    ['/leaderboard/compare/3', 'profile', 'pushed', '/leaderboard', 'nav.leaderboard'],
    ['/collection/user/3', 'profile', 'pushed', '/leaderboard', 'nav.leaderboard'],
    ['/achievements', 'profile', 'pushed', '/profile', 'nav.achievements'],
    ['/achievements/3', 'profile', 'pushed', '/leaderboard', 'nav.achievements'],
    ['/settings', 'profile', 'pushed', '/profile', 'nav.settings'],
    ['/settings/appearance', 'profile', 'pushed', '/settings', 'settings.sections.appearance'],
    ['/offline', 'profile', 'pushed', '/profile', 'sync.centerTitle'],
    ['/migration', 'profile', 'pushed', '/profile', 'migration.title'],
  ]

  it.each(rows)('%s → section %s, %s, parent %s, title %s', (path, section, kind, parent, titleKey) => {
    expect(sectionForPath(path)).toBe(section)
    expect(isRootPath(path)).toBe(kind === 'root')
    expect(parentForPath(path)).toBe(parent)
    expect(titleKeyForPath(path)).toBe(titleKey)
  })

  it('keeps /collection/user/:userId out of the Collection tab', () => {
    expect(tabForPath('/collection')).toBe('collection')
    expect(tabForPath('/collection/user/3')).toBe('profile')
  })

  it('highlights no tab on the scan inbox', () => {
    expect(tabForPath('/scans')).toBeNull()
    expect(tabForPath('/scans/4')).toBeNull()
    expect(sectionForPath('/scans')).toBe('scan')
  })

  it('has a parent that is itself a route for every pushed route', () => {
    for (const route of ROUTES.filter(r => r.kind === 'pushed' && r.parent)) {
      const sample = route.parent.replace(/:[A-Za-z]+/g, 'x')
      expect({ route: route.path, parent: matchRoute(sample)?.kind }).toEqual({ route: route.path, parent: 'route' })
    }
  })

  it('labels back buttons with the parent, "Card Lists" for /binders', () => {
    expect(backLabelKeyForPath('/binders/7')).toBe('nav.binders')
    expect(backLabelKeyForPath('/sets/base1')).toBe('nav.sets')
    expect(backLabelKeyForPath('/analytics')).toBe('nav.profile')
    expect(backLabelKeyForPath('/achievements/3')).toBe('nav.leaderboard')
    expect(backLabelKeyForPath('/')).toBeNull()
  })

  it('marks the pages that render their own back link', () => {
    for (const path of ['/scans/9', '/collection/user/3', '/achievements/3']) {
      expect(isOwnBack(path)).toBe(true)
    }
    for (const path of ['/binders/7', '/decks/1', '/decks/compare', '/sets', '/sets/base1', '/pokedex/25', '/analytics', '/settings', '/profile']) expect(isOwnBack(path)).toBe(false)
  })

  it('classifies redirects, outside-shell pages and unknown paths', () => {
    expect(matchRoute('/dashboard').kind).toBe('redirect')
    expect(matchRoute('/decks/5/build').kind).toBe('redirect')
    expect(matchRoute('/login').kind).toBe('outside')
    expect(matchRoute('/u/misty/binder/3').kind).toBe('outside')
    expect(matchRoute('/__ios').kind).toBe('outside')
    expect(matchRoute('/nowhere')).toBeNull()
  })

  it('has unique route patterns and four tabs', () => {
    expect(new Set(ROUTES.map(r => r.path)).size).toBe(ROUTES.length)
    expect(TABS.map(tab => tab.key)).toEqual(['home', 'collection', 'search', 'profile'])
  })

  it('has an English string for every title, label and tab key', () => {
    const lookup = key => key.split('.').reduce((node, part) => node?.[part], en)
    const keys = [
      ...TABS.map(tab => tab.labelKey),
      ...ROUTES.flatMap(route => [route.titleKey, route.label].filter(Boolean)),
      ...SETTINGS_SECTIONS.map(section => section.titleKey),
    ]
    for (const key of keys) expect({ key, text: typeof lookup(key) }).toEqual({ key, text: 'string' })
  })
})

describe('navConfig and the offline routes', () => {
  it('flags exactly the routes in OFFLINE_ROUTES as offline', () => {
    for (const route of ROUTES) {
      const sample = route.path.replace(/:[A-Za-z]+/g, 'x')
      expect({ path: route.path, offline: isOfflineRoute(sample) }).toEqual({ path: route.path, offline: route.offline })
    }
    for (const pattern of OFFLINE_ROUTES) {
      const route = ROUTES.find(r => r.path === pattern) ?? REDIRECTS.find(r => r.path === pattern)
      expect({ pattern, known: Boolean(route) }).toEqual({ pattern, known: true })
    }
  })
})

describe('settings sections', () => {
  it('lists the eight sections of §5.6 in order', () => {
    expect(SETTINGS_SECTIONS.map(s => s.key)).toEqual([
      'account', 'appearance', 'scanner', 'notifications', 'data', 'users', 'community', 'about',
    ])
  })

  it('leaves out the admin sections for everyone else', () => {
    expect(visibleSettingsSections({ isAdmin: false }).map(s => s.key)).toEqual([
      'account', 'appearance', 'scanner', 'notifications', 'community', 'about',
    ])
    expect(visibleSettingsSections({ isAdmin: true })).toHaveLength(8)
  })
})
