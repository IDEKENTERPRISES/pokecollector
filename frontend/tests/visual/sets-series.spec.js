import { expect, test } from '@playwright/test'

// Search Browse, Sets by series and the series page (docs/IOS_UI_DESIGN.md §5.4, OD-F).
// Mobile project only: the phone shell hosts these screens.

const USER = { id: 1, username: 'Series Reviewer', role: 'admin', is_active: true, must_change_password: false, avatar_id: null }

const SETS = [
  { id: 'sv1_en', name: 'Scarlet & Violet', series: 'Scarlet & Violet', series_id: 'sv', release_date: '2023-03-31', total: 10, owned_count: 4, lang: 'en', abbreviation: 'SVI', is_new: false },
  { id: 'sv2_en', name: 'Paldea Evolved', series: 'Scarlet & Violet', series_id: 'sv', release_date: '2023-06-09', total: 20, owned_count: 6, lang: 'en', abbreviation: 'PAL', is_new: true },
  { id: 'swsh1_en', name: 'Sword & Shield', series: 'Sword & Shield', series_id: 'swsh', release_date: '2020-02-07', total: 5, owned_count: 5, lang: 'en', abbreviation: 'SSH', is_new: false },
  { id: 'base1_en', name: 'Base Set', series: 'Base', series_id: 'base', release_date: '1999-01-09', total: 4, owned_count: 1, lang: 'en', abbreviation: 'BS', is_new: false },
]

async function installApi(page, { settings = {} } = {}) {
  await page.addInitScript(user => {
    localStorage.setItem('token', 'sets-series-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
  }, USER)
  const state = { offline: false }
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (state.offline) return route.abort('connectionrefused')
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: USER })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR', tcgdex_sync_languages: 'en', ...settings } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: ['en'] })
    if (path === '/api/sets/') return route.fulfill({ json: SETS })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/cards/custom') return route.fulfill({ json: [] })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    if (path.startsWith('/api/images/') || path.startsWith('/api/pokedex/images/')) return route.fulfill({ status: 404, json: {} })
    if (path === '/api/pokedex' || path === '/api/pokedex/') return route.fulfill({ json: { entries: [], summary: { total: 1025, owned: 10, missing: 1015 } } })
    return route.fulfill({ json: [] })
  })
  return state
}

test.describe('sets by series', () => {
  test.skip(({ viewport }) => viewport.width >= 1024, 'the phone shell is not shown at desktop width')

  test('Sets shows series by default and a series opens its sets', async ({ page }) => {
    await installApi(page)
    await page.goto('/sets')

    const grid = page.getByTestId('series-grid')
    await expect(grid.getByRole('link')).toHaveCount(3)
    // Newest series first, totals are sums of the sets
    await expect(grid.getByRole('link').first()).toContainText('Scarlet & Violet')
    await expect(grid.getByRole('link').first()).toContainText('2 sets')
    await expect(grid.getByRole('link').first()).toContainText('10 of 30')
    await expect(grid.getByRole('link').nth(1)).toContainText('Complete')

    await grid.getByRole('link').first().click()
    await expect(page).toHaveURL(/\/sets\/series\/sv$/)
    await expect(page.getByTestId('nav-title')).toHaveText('Scarlet & Violet')
    await expect(page.getByTestId('series-header')).toContainText('10 of 30')
    const tiles = page.getByTestId('set-tile')
    await expect(tiles).toHaveCount(2)
    await expect(tiles.first()).toContainText('Paldea Evolved')
    await expect(tiles.nth(1)).toContainText('Scarlet & Violet')
  })

  test('with sets_view set to sets the page shows the plain set grid', async ({ page }) => {
    await installApi(page, { settings: { sets_view: 'sets' } })
    await page.goto('/sets')
    await expect(page.getByTestId('sets-grid').getByTestId('set-tile')).toHaveCount(4)
    await expect(page.getByTestId('series-grid')).toHaveCount(0)
  })

  test('Browse, the series view and the series page work offline from the cache', async ({ page }) => {
    const state = await installApi(page)
    await page.goto('/search')
    const browse = page.getByTestId('search-browse')
    await expect(browse.getByTestId('browse-sets')).toContainText('1 new')
    await expect(browse.getByTestId('browse-sets')).toContainText('3 series · 4 sets')
    await expect(browse.getByTestId('browse-pokedex')).toContainText('10 of 1,025 caught')

    await browse.getByTestId('browse-sets').click()
    await expect(page.getByTestId('series-grid').getByRole('link')).toHaveCount(3)

    state.offline = true
    await page.getByTestId('tab-search').click()
    await expect(page.getByTestId('search-browse')).toBeVisible()
    await expect(page.getByRole('searchbox')).toBeEnabled()
    await page.getByTestId('browse-sets').click()
    await expect(page.getByTestId('series-grid').getByRole('link')).toHaveCount(3)
    await page.getByTestId('series-grid').getByRole('link').first().click()
    await expect(page.getByTestId('set-tile')).toHaveCount(2)
    await expect(page.getByTestId('series-header')).toContainText('10 of 30')
  })

  test('Browse by type opens the existing type filter in the URL', async ({ page }) => {
    await installApi(page)
    await page.goto('/search')
    await expect(page.getByTestId('search-browse').locator('[data-testid^="browse-type-"]')).toHaveCount(11)
    await page.getByTestId('browse-type-fire').click()
    await expect(page).toHaveURL(/\/search\?type=Fire$/)
  })
})
