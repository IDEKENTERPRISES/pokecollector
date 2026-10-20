import { expect, test } from '@playwright/test'

const admin = { id: 1, username: 'admin', role: 'admin', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}

// A tiny valid JPEG header is enough: the server is mocked and only sizes are checked.
const jpeg = (size, name = 'card.jpg') => ({ name, mimeType: 'image/jpeg', buffer: Buffer.alloc(size, 7) })

// `state.health`: 'down' (503) or 'up'. Records every upload to the jobs endpoint.
async function mockApi(context, state) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/health') {
      return state.health === 'up' ? route.fulfill({ json: HEALTH_OK }) : route.fulfill({ status: 503, json: {} })
    }
    if (path === '/api/cards/recognize/jobs' && request.method() === 'POST') {
      state.uploads.push({ headers: request.headers(), bytes: request.postDataBuffer()?.length ?? 0 })
      return route.fulfill({ json: { id: 41 } })
    }
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: admin })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/settings/scanner') return route.fulfill({ json: { visual_verification: 'disabled' } })
    return route.fulfill({ json: [] })
  })
}

async function openScanner(page) {
  await page.goto('/search')
  // The tab bar's Scan circle (the sidebar's "Scan cards" button from 1024 px). Without a camera the
  // review sheet opens on its own with the photo pickers.
  await page.locator('[data-testid="scan-button"]:visible, [data-testid="sidebar-nav"] button:has-text("Scan cards")').first().click()
  await expect(page.getByText('0/50 Photos')).toBeVisible()
}

const outboxItemCount = page => page.evaluate(() => new Promise((resolve, reject) => {
  const open = indexedDB.open('pokecollector-outbox')
  open.onerror = () => reject(open.error)
  open.onsuccess = () => {
    const db = open.result
    const request = db.transaction('items').objectStore('items').count()
    request.onsuccess = () => {
      db.close()
      resolve(request.result)
    }
  }
}))

test('a scan taken while the server is unreachable is saved on the device and uploaded later', async ({ page }) => {
  const state = { health: 'down', uploads: [] }
  await mockApi(page.context(), state)
  await openScanner(page)

  await page.locator('input[multiple]').setInputFiles([jpeg(2000, 'a.jpg'), jpeg(3000, 'b.jpg'), jpeg(4000, 'c.jpg')])
  await page.getByRole('button', { name: 'Start scanning' }).click()
  await expect(page.getByText('Saved on this device. It will sync automatically.')).toBeVisible()
  await expect(page.getByText('0/50 Photos')).toBeHidden()
  expect(await outboxItemCount(page)).toBe(1)
  expect(state.uploads).toHaveLength(0)

  state.health = 'up'
  await page.getByTestId('sync-indicator').click()
  await page.getByRole('button', { name: /sync now/i }).click()
  await expect.poll(() => state.uploads.length).toBe(1)
  expect(state.uploads[0].headers['idempotency-key']).toBeTruthy()
  expect(state.uploads[0].headers['x-expected-user-id']).toBe('1')
  // Playwright's WebKit does not report Blob parts in the recorded body, so only Chromium can check size.
  if (test.info().project.name === 'chromium-page') expect(state.uploads[0].bytes).toBeGreaterThanOrEqual(9000)
  await expect.poll(() => outboxItemCount(page)).toBe(0)
})

test('a photo larger than 15 MB is refused', async ({ page }) => {
  await mockApi(page.context(), { health: 'down', uploads: [] })
  await openScanner(page)
  await page.locator('input[capture]').setInputFiles(jpeg(16 * 1024 * 1024, 'big.jpg'))
  await expect(page.getByText("This photo is larger than 15 MB and can't be uploaded.")).toBeVisible()
  await expect(page.getByText('0/50 Photos')).toBeVisible()
})

test('storage that is full keeps the staged photos', async ({ page }) => {
  await mockApi(page.context(), { health: 'down', uploads: [] })
  await page.addInitScript(() => localStorage.setItem('pc.debug.forceQuota', '1'))
  await openScanner(page)
  await page.locator('input[capture]').setInputFiles(jpeg(2000))
  await page.getByRole('button', { name: 'Start scanning' }).click()
  await expect(page.getByText(/Not enough storage/)).toBeVisible()
  await expect(page.getByText('1/50 Photos')).toBeVisible()
})
