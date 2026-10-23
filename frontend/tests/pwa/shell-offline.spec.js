import { expect, test } from '@playwright/test'

// The iPhone shell offline (docs/IOS_UI_DESIGN.md §12): the tab bar stays, the status line shows,
// /profile renders its cached numbers and /analytics (never opened) shows its normal page with a note.

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}

async function mockApi(context, state) {
  await context.route(url => url.pathname.startsWith('/api/'), async route => {
    if (state.hang) return new Promise(() => {}) // never answers, like Airplane Mode on iPhone
    if (state.offline) return route.abort('connectionrefused')
    const path = new URL(route.request().url()).pathname
    if (state.slow && path === state.slow.path) await new Promise(resolve => setTimeout(resolve, state.slow.ms))
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

test('offline: the tab bar stays, the status line shows, Profile keeps its numbers, Analytics opens from its saved copy', async ({ page, context }) => {
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
  // The sign-in prefetch saved Analytics too, so it opens like any other page (no "not saved yet" note).
  await expect(page.getByTestId('offline-unavailable')).toHaveCount(0)
  await expect(tabBar).toBeVisible()
  await expect(page.getByTestId('offline-banner')).toBeVisible()
})

// Owner feedback F7: online, then airplane mode, then a pull must not spin for ever.
async function pullDown(page) {
  await page.evaluate(() => {
    const send = (type, y) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientY: y }] })
      document.body.dispatchEvent(event)
    }
    send('touchstart', 120)
    send('touchmove', 160)
    send('touchmove', 360)
    send('touchend', 360)
  })
}

async function openProfileSignedIn(page, context, state) {
  await mockApi(context, state)
  await page.addInitScript(user => {
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('user', JSON.stringify(user))
  }, ada)
  await page.goto('/profile')
  await expect(page.getByText('4242')).toBeVisible()
}

test('going offline while the app is open: a pull shows "Offline mode" and the spinner stops', async ({ page, context }) => {
  const state = { offline: false }
  await openProfileSignedIn(page, context, state)
  await context.setOffline(true)
  state.offline = true

  await pullDown(page)
  const indicator = page.getByTestId('pull-indicator')
  await expect(indicator).toHaveAttribute('data-note', 'offline', { timeout: 8000 })
  await expect(indicator).toContainText('Offline mode')
  await expect(indicator).toHaveAttribute('data-phase', 'idle', { timeout: 8000 })
  await context.setOffline(false)
})

test('iPhone airplane mode (still "online", every request hangs): a pull shows "Offline mode" and stops', async ({ page, context }) => {
  const state = { offline: false }
  await openProfileSignedIn(page, context, state)
  await page.route(url => url.pathname.startsWith('/api/'), () => {})
  expect(await page.evaluate(() => navigator.onLine)).toBe(true)

  await pullDown(page)
  const indicator = page.getByTestId('pull-indicator')
  await expect(indicator).toHaveAttribute('data-note', 'offline', { timeout: 10000 })
  await expect(indicator).toHaveAttribute('data-phase', 'idle', { timeout: 8000 })
})

// Owner feedback F10: the app is open, navigator.onLine stays true (as on iPhone in Airplane Mode)
// and the API stops answering. The offline banner must follow, and clear again by itself.
const banner = page => page.getByTestId('offline-banner')
const openSets = page => page.getByTestId('sidebar-nav').getByRole('link', { name: 'Sets', exact: true }).click()

test.describe('offline banner while the app is open', () => {
  test.setTimeout(90000)

  test('a pull to refresh with a dead connection shows the banner at once, and a pull with the server back clears it at once', async ({ page, context }) => {
    const state = { offline: false }
    await openProfileSignedIn(page, context, state)
    await expect(banner(page)).toHaveCount(0)
    expect(await page.evaluate(() => navigator.onLine)).toBe(true)

    state.hang = true
    await pullDown(page)
    await expect(banner(page)).toBeVisible({ timeout: 8000 })
    await expect(page.getByTestId('pull-indicator')).toHaveAttribute('data-phase', 'idle', { timeout: 8000 })

    state.hang = false
    await pullDown(page)
    await expect(banner(page)).toHaveCount(0, { timeout: 8000 })
  })

  test('navigating to a page that loads while requests fail shows the banner, and it clears by itself when the network is back', async ({ page, context }) => {
    const state = { offline: false }
    await openProfileSignedIn(page, context, state)
    await expect(banner(page)).toHaveCount(0)

    state.offline = true // every request now fails at once, navigator.onLine stays true
    await openSets(page)
    await expect(page.getByTestId('nav-title')).toHaveText('Sets')
    await expect(banner(page)).toBeVisible({ timeout: 15000 })

    state.offline = false
    await expect(banner(page)).toHaveCount(0, { timeout: 25000 })
  })

  test('requests that hang (no error, no answer) show the banner after a few seconds, and it clears by itself', async ({ page, context }) => {
    const state = { offline: false }
    await openProfileSignedIn(page, context, state)
    await expect(banner(page)).toHaveCount(0)

    state.hang = true
    await openSets(page)
    await expect(page.getByTestId('nav-title')).toHaveText('Sets')
    // About 5 s until the hint, then two failed probes with the 1 s confirmation between them.
    await expect(banner(page)).toBeVisible({ timeout: 30000 })

    state.hang = false
    await expect(banner(page)).toHaveCount(0, { timeout: 30000 })
  })

  test('a server that is reachable but slow never shows the banner', async ({ page, context }) => {
    const state = { offline: false, slow: { path: '/api/sets/', ms: 8000 } }
    await openProfileSignedIn(page, context, state)
    await openSets(page)
    await expect(page.getByTestId('nav-title')).toHaveText('Sets')
    // The request is still pending after 5 s, the hint triggers a health check, the server answers it.
    await page.waitForTimeout(10000)
    await expect(banner(page)).toHaveCount(0)
  })
})
