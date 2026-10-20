import { expect, test } from '@playwright/test'

// The iPhone shell offline (docs/IOS_UI_DESIGN.md §12): the tab bar stays, the status line shows,
// /profile renders its cached numbers and /analytics shows OfflineUnavailable.

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}

async function mockApi(context, state) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    if (state.offline) return route.abort('connectionrefused')
    const path = new URL(route.request().url()).pathname
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: ada })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: ['en'] })
    if (path === '/api/dashboard/') {
      return route.fulfill({ json: { total_cards: 4242, owned_sets: 17, recent_additions: [], top_cards: [] } })
    }
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    if (path.startsWith('/api/images/') || path.startsWith('/api/pokedex/')) return route.fulfill({ status: 404, json: {} })
    return route.fulfill({ json: [] })
  })
}

test('offline: the tab bar stays, the status line shows, Profile keeps its numbers, Analytics is unavailable', async ({ page, context }) => {
  const state = { offline: false }
  await mockApi(context, state)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(user => {
    if (!sessionStorage.getItem('pc-test-seeded')) {
      sessionStorage.setItem('pc-test-seeded', '1')
      localStorage.setItem('token', 'test-token')
      localStorage.setItem('user', JSON.stringify(user))
    }
  }, ada)

  await page.goto('/profile')
  const tabBar = page.getByTestId('tab-bar')
  await expect(tabBar).toBeVisible()
  await expect(tabBar.getByRole('link', { name: 'Profile' })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('profile-tiles')).toContainText('Analytics')
  await expect(page.getByText('4242')).toBeVisible()
  // The read cache saves its record 5 s after the first successful fetch; wait for the dashboard.
  await expect(async () => {
    const saved = await page.evaluate(async id => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('pokecollector-readcache')
        request.onupgradeneeded = () => request.result.createObjectStore('qc')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const record = await new Promise((resolve, reject) => {
        const request = db.transaction('qc').objectStore('qc').get(`${location.origin}|${id}`)
        request.onsuccess = () => resolve(request.result ?? null)
        request.onerror = () => reject(request.error)
      })
      db.close()
      return record ? record.state.queries.map(query => query.queryKey[0]) : []
    }, ada.id)
    expect(saved).toContain('dashboard')
  }).toPass({ timeout: 20000 })

  state.offline = true
  await page.reload()

  await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('stale-data-label')).toContainText('Showing saved data from')
  await expect(tabBar).toBeVisible()
  await expect(page.getByText('4242')).toBeVisible()

  await page.getByTestId('profile-tiles').getByRole('link', { name: /Analytics/ }).click()
  await expect(page).toHaveURL(/\/analytics$/)
  await expect(page.getByTestId('offline-unavailable')).toBeVisible()
  await expect(tabBar).toBeVisible()
  await expect(page.getByTestId('offline-banner')).toBeVisible()
})
