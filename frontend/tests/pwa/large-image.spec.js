import { expect, test } from '@playwright/test'

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}
// 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const card = {
  id: 'big-0_en',
  card_id: 'big-0_en',
  name: 'Largeimage Probe',
  number: '001',
  set_id: 'big-set_en',
  set_name: 'Big Set',
  set_ref: { id: 'big-set_en', name: 'Big Set', abbreviation: 'BIG' },
  rarity: 'Common',
  supertype: 'Pokemon',
  types: ['Lightning'],
  attacks: [],
  price_market: 1,
  price_trend: 1,
  variants_normal: true,
}
const collection = [{
  id: 1, card_id: card.id, quantity: 1, variant: 'Normal', condition: 'NM', lang: 'en',
  added_at: '2026-09-12T12:00:00', card,
}]

// Only the small image exists on the "server": the large one has never been opened online.
async function mockApi(context, state) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    if (state.offline) return route.abort('connectionfailed')
    const path = new URL(route.request().url()).pathname
    if (path === '/api/images/card/big-0_en/small') {
      return route.fulfill({ status: 200, body: PNG, headers: { 'Content-Type': 'image/png' } })
    }
    if (path.startsWith('/api/images/')) return route.fulfill({ status: 404, json: {} })
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: ada })
    if (path === '/api/collection/') return route.fulfill({ json: collection })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: ['en'] })
    if (path === '/api/dashboard/') return route.fulfill({ json: { recent_additions: [], top_cards: [] } })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    return route.fulfill({ json: [] })
  })
}

test('offline, the card detail shows the cached small image instead of a broken one', async ({ page, context }) => {
  const state = { offline: false }
  await mockApi(context, state)
  await page.addInitScript(account => {
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('user', JSON.stringify(account))
  }, ada)
  await page.goto('/collection')
  await page.waitForFunction(async () => Boolean(await navigator.serviceWorker.getRegistration()), null, { timeout: 15000 })
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  const grid = page.locator('img[src*="/api/images/card/big-0_en/small"]').first()
  await expect(grid).toBeVisible()
  await expect.poll(() => grid.evaluate(img => img.naturalWidth)).toBeGreaterThan(0)
  // The worker stores the small copy asynchronously.
  await expect.poll(() => page.evaluate(async () => {
    const hit = await (await caches.open('pc-images-v1')).match('/api/images/card/big-0_en/small')
    return Boolean(hit)
  })).toBe(true)

  state.offline = true
  await page.getByRole('button', { name: 'Largeimage Probe' }).click()

  const detail = page.locator('img[src*="/api/images/card/big-0_en/large"]').first()
  await expect(detail).toBeVisible()
  await expect.poll(() => detail.evaluate(img => img.complete && img.naturalWidth)).toBeGreaterThan(0)
})

// iOS Airplane Mode: a request for a picture is neither answered nor refused. The worker must give up
// after a few seconds so the tile shows its "artwork unavailable" state instead of loading forever,
// and a picture that was downloaded on purpose (Settings > Data & sync) must still show.
test('offline, a picture that is not saved fails fast instead of loading forever', async ({ page, context }) => {
  test.setTimeout(90000)
  const named = (index, name) => ({
    ...card, id: `hang-${index}_en`, card_id: `hang-${index}_en`, name, number: String(index),
  })
  const cards = [named(1, 'Savedpic Probe'), named(2, 'Downloadedpic Probe'), named(3, 'Missingpic Probe')]
  const state = { offline: false }
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    if (path.startsWith('/api/images/')) {
      if (state.offline) return undefined // never answered
      if (path === '/api/images/card/hang-1_en/small') {
        return route.fulfill({ status: 200, body: PNG, headers: { 'Content-Type': 'image/png' } })
      }
      return undefined // the other pictures never come, offline or not
    }
    if (state.offline) return undefined
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: ada })
    if (path === '/api/collection/') {
      return route.fulfill({
        json: cards.map((item, index) => ({ id: index + 1, card_id: item.id, quantity: 1, variant: 'Normal', condition: 'NM', lang: 'en', added_at: '2026-09-12T12:00:00', card: item })),
      })
    }
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: ['en'] })
    if (path === '/api/dashboard/') return route.fulfill({ json: { recent_additions: [], top_cards: [] } })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    return route.fulfill({ json: [] })
  })
  await page.addInitScript(account => {
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('user', JSON.stringify(account))
  }, ada)
  await page.goto('/profile')
  await page.waitForFunction(async () => Boolean(await navigator.serviceWorker.getRegistration()), null, { timeout: 15000 })
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))

  // One picture saved by browsing, one downloaded on purpose (the same way F13a stores it).
  await page.evaluate(async png => {
    const bytes = Uint8Array.from(atob(png), char => char.charCodeAt(0))
    const downloaded = await caches.open('pc-carddb-images-v1-en')
    await downloaded.put('/api/images/card/hang-2_en/small', new Response(bytes, { headers: { 'Content-Type': 'image/png' } }))
  }, PNG.toString('base64'))
  await page.goto('/collection')
  const saved = page.locator('img[src*="/api/images/card/hang-1_en/small"]').first()
  await expect.poll(() => saved.evaluate(img => img.complete && img.naturalWidth)).toBeGreaterThan(0)
  await expect.poll(() => page.evaluate(async () => Boolean(await (await caches.open('pc-images-v1')).match('/api/images/card/hang-1_en/small')))).toBe(true)

  await page.waitForTimeout(7000) // the read cache saves its record 5 s after a fetch
  state.offline = true
  await page.reload()
  const downloaded = page.locator('img[src*="/api/images/card/hang-2_en/small"]').first()
  await expect.poll(() => downloaded.evaluate(img => img.complete && img.naturalWidth), { timeout: 15000 }).toBeGreaterThan(0)
  await expect(page.locator('img[src*="/api/images/card/hang-1_en/small"]').first()).toBeVisible()

  // The third picture exists nowhere: after about 3 s its tile shows the unavailable state, and the
  // skeleton that says "loading" is gone from it.
  await expect(page.locator('.unified-card-image-error')).toHaveCount(1, { timeout: 15000 })
  await expect(page.locator('.unified-card-image-error')).toContainText('Artwork unavailable')
  await expect(page.locator('.unified-card-skeleton')).toHaveCount(0)
})
