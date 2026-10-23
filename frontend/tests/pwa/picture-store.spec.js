import { expect, test } from '@playwright/test'
import { seedPictureStore, storedPictureCount } from './fixtures/picture-store.js'

// F16a: downloaded card pictures live in the IndexedDB picture store (one Blob per set plus an index), and
// the service worker answers /api/images/card/{id}/small|large from it, also offline. Pictures that were
// downloaded before (pc-carddb-images-v1-<lang> caches) are deleted in the background after start-up.

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}

// Offline the iPhone way: requests are neither answered nor refused.
async function mockApi(context, state) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    if (state.offline) return undefined
    const path = new URL(route.request().url()).pathname
    if (path.startsWith('/api/images/') || path.startsWith('/api/pokedex/')) return route.fulfill({ status: 404, json: {} })
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: ada })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: ['en'] })
    if (path === '/api/dashboard/') return route.fulfill({ json: { recent_additions: [], top_cards: [] } })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    return route.fulfill({ json: [] })
  })
  await context.addInitScript(account => {
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('user', JSON.stringify(account))
  }, ada)
}

async function controlledPage(page) {
  await page.goto('/profile')
  await page.waitForFunction(async () => Boolean(await navigator.serviceWorker.getRegistration()), null, { timeout: 15000 })
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
}

const probe = (page, path) => page.evaluate(async url => {
  const started = performance.now()
  try {
    const response = await fetch(url)
    const bytes = (await response.arrayBuffer()).byteLength
    return { ok: response.ok, type: response.headers.get('Content-Type'), bytes, ms: Math.round(performance.now() - started) }
  } catch {
    return { ok: false, ms: Math.round(performance.now() - started) }
  }
}, path)

test('offline, downloaded pictures come from the picture store at once and large falls back to small', async ({ page, context }) => {
  test.setTimeout(90000)
  const state = { offline: false }
  await mockApi(context, state)
  await controlledPage(page)
  expect(await seedPictureStore(page, { items: [{ id: 'ps-1_en' }, { id: 'ps-2_en' }] })).toBe(2)

  state.offline = true
  const small = await probe(page, '/api/images/card/ps-1_en/small')
  expect(small).toMatchObject({ ok: true, type: 'image/png' })
  expect(small.bytes).toBeGreaterThan(0)
  expect(small.ms).toBeLessThan(1000)
  const large = await probe(page, '/api/images/card/ps-2_en/large')
  expect(large).toMatchObject({ ok: true, type: 'image/png' })
  const missing = await probe(page, '/api/images/card/ps-9_en/small')
  expect(missing.ok).toBe(false)
  expect(missing.ms).toBeLessThan(4500) // the worker's 3 s give-up (it has not been told about the lost connection here)
  // Nothing was written to Cache Storage for them.
  expect(await page.evaluate(async () => (await caches.keys()).filter(name => name.startsWith('pc-carddb-images-')))).toEqual([])
  expect(await storedPictureCount(page)).toBe(2)
})

test('the old picture caches are deleted in the background after start-up and the language reads as not downloaded', async ({ page, context }) => {
  test.setTimeout(120000)
  const state = { offline: false }
  await mockApi(context, state)
  await controlledPage(page)
  await page.evaluate(async () => {
    const cache = await caches.open('pc-carddb-images-v1-en')
    for (let i = 0; i < 20; i += 1) await cache.put(`/api/images/card/old-${i}_en/small`, new Response('x', { headers: { 'Content-Type': 'image/png' } }))
    localStorage.setItem('pc-carddb-pictures-v1-en', JSON.stringify({ sets: { a_en: { bytes: 1, skipped: 0 } } }))
    localStorage.setItem('pc-carddb-prefs', JSON.stringify({ enabled: true, languages: {}, pictures: { en: true } }))
    localStorage.removeItem('pc-carddb-pictures-migration-done-v1')
  })
  await page.reload()
  // Not on the launch path: the caches are still there right after the first screen.
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).includes('pc-carddb-images-v1-en')), { timeout: 2000 }).toBe(true)
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).includes('pc-carddb-images-v1-en')), { timeout: 60000 }).toBe(false)
  const after = await page.evaluate(() => ({
    notice: JSON.parse(localStorage.getItem('pc-carddb-pictures-migrated-v1') || '[]'),
    prefs: JSON.parse(localStorage.getItem('pc-carddb-prefs') || '{}'),
    record: localStorage.getItem('pc-carddb-pictures-v1-en'),
  }))
  expect(after.notice).toEqual(['en'])
  expect(after.prefs.pictures.en).toBe(false)
  expect(after.record).toBeNull()
})
