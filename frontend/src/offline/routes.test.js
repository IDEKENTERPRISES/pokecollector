import { describe, expect, it } from 'vitest'
import { REDIRECTS, ROUTES } from '../navigation/navConfig.js'
import { OFFLINE_EXCEPTIONS, isOfflineRoute } from './routes.js'

describe('isOfflineRoute (every page of the shell opens offline)', () => {
  it('accepts every route of the shell, with params filled in', () => {
    for (const route of ROUTES) {
      expect(isOfflineRoute(route.path.replace(/:[A-Za-z]+/g, 'abc'))).toBe(true)
    }
  })

  it('accepts the pages that were blocked before F12', () => {
    for (const path of [
      '/decks/12', '/decks/compare', '/pokedex', '/pokedex/25', '/analytics', '/products', '/trades',
      '/leaderboard', '/achievements', '/settings', '/settings/appearance', '/scans', '/scans/3', '/migration',
      '/sets/base1_en', '/sets/series/sv', '/binders/42', '/collection/user/3',
    ]) {
      expect({ path, offline: isOfflineRoute(path) }).toEqual({ path, offline: true })
    }
  })

  it('ignores a trailing slash', () => {
    expect(isOfflineRoute('/collection/')).toBe(true)
    expect(isOfflineRoute('/sets/base1/')).toBe(true)
  })

  it('does not treat unknown paths, redirects or pages outside the shell as shell pages', () => {
    for (const path of ['/nowhere', '/login', '/u/misty', '/sets/base1/extra', '', undefined]) {
      expect(isOfflineRoute(path)).toBe(false)
    }
    for (const redirect of REDIRECTS) expect(isOfflineRoute(redirect.path.replace(/:[A-Za-z]+/g, 'abc'))).toBe(false)
  })

  it('has no exceptions: a page that cannot work offline would have to be listed with a reason', () => {
    expect(OFFLINE_EXCEPTIONS).toEqual([])
  })
})
