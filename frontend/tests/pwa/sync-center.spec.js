import { expect, test } from '@playwright/test'

const admin = { id: 1, username: 'admin', role: 'admin', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}

// `state.health`: 'down' (503) or 'up'. Everything else answers with empty data.
async function mockApi(context, state = { health: 'down' }) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/health') {
      return state.health === 'up' ? route.fulfill({ json: HEALTH_OK }) : route.fulfill({ status: 503, json: {} })
    }
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: admin })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/dashboard/') return route.fulfill({ json: { recent_additions: [], top_cards: [] } })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    return route.fulfill({ json: [] })
  })
  return state
}

// Writes items straight into the outbox database the app created (waits for its stores).
async function seed(page, overrides) {
  await page.evaluate(async list => {
    const make = override => {
      const now = Date.now()
      return {
        id: crypto.randomUUID(),
        schema: 1,
        idempotencyKey: crypto.randomUUID(),
        serverOrigin: location.origin,
        userId: 1,
        type: 'wishlist.add',
        payload: { card_id: 'base1-4' },
        photoCount: 0,
        photoBytes: 0,
        state: 'pending',
        createdAt: now,
        updatedAt: now,
        attempts: 0,
        retryCount: 0,
        serverErrorCount: 0,
        firstSentAt: null,
        lastAttemptAt: null,
        nextAttemptAt: 0,
        maybeApplied: false,
        claim: null,
        lastError: null,
        display: { title: 'Charizard', subtitle: '', imageUrl: null },
        appVersion: '',
        minApiLevel: 1,
        ...override,
      }
    }
    const open = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('pokecollector-outbox')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    let db = await open()
    for (let i = 0; i < 50 && !db.objectStoreNames.contains('items'); i += 1) {
      db.close()
      await new Promise(resolve => setTimeout(resolve, 100))
      db = await open()
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['items', 'meta'], 'readwrite')
      for (const override of list) tx.objectStore('items').put(make(override))
      // A page reloaded mid-sync leaves its 30 s lease behind; the next page would wait it out.
      tx.objectStore('meta').delete('lease')
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, Array.isArray(overrides) ? overrides : [overrides])
}

async function openApp(page) {
  await page.goto('/')
  await expect(page.getByText('Hello,')).toBeVisible()
}

const indicator = page => page.getByTestId('sync-indicator')
const failedError = { kind: 'http', status: 400, code: 'bad_request', message: 'Bad request', at: Date.now() }

// Pushes a client-side navigation without a reload (the outbox keeps its reachability state).
const navigate = (page, path) => page.evaluate(target => {
  history.pushState({}, '', target)
  dispatchEvent(new PopStateEvent('popstate'))
}, path)

test.describe('sync center', () => {
  test('is invisible with an empty queue and a reachable server', async ({ page, context }) => {
    await mockApi(context, { health: 'up' })
    await openApp(page)
    await expect(indicator(page)).toHaveCount(0)
    await expect(page.getByTestId('offline-banner')).toHaveCount(0)
  })

  test('indicator shows the attention state with an aria label', async ({ page, context }) => {
    await mockApi(context, { health: 'up' })
    await openApp(page)
    await seed(page, { state: 'failed', lastError: failedError })
    await page.reload()
    await expect(indicator(page)).toHaveAttribute('data-state', 'attention')
    await expect(indicator(page)).toHaveAttribute('aria-label', 'Needs attention: 1')
  })

  test('sheet: Retry moves failed to pending, Discard asks first and removes', async ({ page, context }) => {
    await mockApi(context, { health: 'down' })
    await openApp(page)
    await seed(page, { state: 'failed', lastError: failedError })
    await page.reload()
    await indicator(page).click()

    const sheet = page.getByTestId('sync-sheet')
    const item = sheet.getByTestId('sync-item')
    await expect(item).toHaveAttribute('data-state', 'failed')
    await expect(item).toContainText('Bad request')
    await item.getByRole('button', { name: 'Retry' }).click()
    await expect(item).toHaveAttribute('data-state', 'pending')

    await item.getByRole('button', { name: 'Discard' }).click()
    const confirm = page.getByRole('dialog').filter({ hasText: 'cannot be recovered' })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(item).toHaveCount(1)

    await item.getByRole('button', { name: 'Discard' }).click()
    await confirm.getByRole('button', { name: 'Discard' }).click()
    await expect(sheet.getByText('Everything is synced.')).toBeVisible()
  })

  test('banner appears after two failed probes and clears after one success', async ({ page, context }) => {
    const state = await mockApi(context, { health: 'down' })
    await openApp(page)
    await seed(page, { state: 'pending' })
    await page.reload()
    // The reachability monitor probes on its own, so the banner may already be up.
    await indicator(page).click()
    const syncNow = page.getByTestId('sync-sheet').getByRole('button', { name: 'Sync now' })
    // A click while the startup sync is still running is skipped, so retry until the second failed probe lands.
    await expect(async () => {
      await syncNow.click()
      await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 1500 })
    }).toPass({ timeout: 15000 })
    await expect(page.getByTestId('offline-banner')).toHaveAttribute('role', 'status')

    state.health = 'up'
    // A click while a probe or sync is still running is skipped, so retry until the banner clears.
    await expect(async () => {
      await syncNow.click()
      await expect(page.getByTestId('offline-banner')).toHaveCount(0, { timeout: 1500 })
    }).toPass({ timeout: 15000 })
  })

  test('pages that need the server show OfflineUnavailable while offline', async ({ page, context }) => {
    await mockApi(context, { health: 'down' })
    await openApp(page)
    await seed(page, { state: 'pending' })
    await page.reload()
    await indicator(page).click()
    const syncNow = page.getByTestId('sync-sheet').getByRole('button', { name: 'Sync now' })
    await expect(async () => {
      await syncNow.click()
      await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 1500 })
    }).toPass({ timeout: 15000 })
    await page.keyboard.press('Escape')

    await navigate(page, '/analytics')
    await expect(page.getByTestId('offline-unavailable')).toBeVisible()
    await expect(page.getByText('This page isn\'t available offline.')).toBeVisible()
    await navigate(page, '/collection')
    await expect(page.getByTestId('offline-unavailable')).toHaveCount(0)
    await navigate(page, '/offline')
    await expect(page.getByTestId('offline-center')).toBeVisible()
  })

  test('a device reporting offline shows the banner without waiting for probes', async ({ page, context }) => {
    await mockApi(context, { health: 'up' })
    await openApp(page)
    await seed(page, { state: 'pending' })
    await page.reload()
    await expect(indicator(page)).toBeVisible()
    await context.setOffline(true)
    await expect(page.getByTestId('offline-banner')).toBeVisible()
    await context.setOffline(false)
    await expect(page.getByTestId('offline-banner')).toHaveCount(0)
  })

  test('the spinner animation is removed under prefers-reduced-motion', async ({ page, context }) => {
    await mockApi(context, { health: 'up' })
    await openApp(page)
    await seed(page, { state: 'sending', claim: { owner: 'other:tab', expiresAt: Date.now() + 3600000 } })
    await page.reload()
    await expect(indicator(page)).toHaveAttribute('data-state', 'syncing')
    const animation = () => indicator(page).locator('svg').evaluate(node => getComputedStyle(node).animationName)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    expect(await animation()).toBe('spin')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await animation()).toBe('none')
  })

  test('the sheet traps focus and closes on Escape', async ({ page, context }) => {
    await mockApi(context, { health: 'down' })
    await openApp(page)
    await seed(page, { state: 'failed', lastError: failedError })
    await page.reload()
    await indicator(page).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button').first().focus()
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab')
      expect(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') ? 'in' : String(document.activeElement?.outerHTML).slice(0, 120))).toBe('in')
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('items of another account are only counted', async ({ page, context }) => {
    await mockApi(context, { health: 'down' })
    await openApp(page)
    await seed(page, [{ state: 'pending' }, { userId: 99, state: 'pending', display: { title: 'Secret card' } }])
    await page.reload()
    await indicator(page).click()
    const sheet = page.getByTestId('sync-sheet')
    await expect(sheet.getByTestId('sync-item')).toHaveCount(1)
    await expect(sheet).not.toContainText('Secret card')
    await expect(sheet).toContainText('Items for other accounts are waiting on this device: 1')
  })

  test('/offline shows the connection and a reset button', async ({ page, context }) => {
    await mockApi(context, { health: 'up' })
    await page.goto('/offline')
    await expect(page.getByTestId('offline-center')).toBeVisible()
    await expect(page.getByTestId('connection-state')).toHaveAttribute('data-state', 'reachable')
    await expect(page.getByText('Server version: 1.51.6 (API 1)')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reset' })).toBeVisible()
  })
})
