import { expect, test } from '@playwright/test'

// Owner feedback F11: a session that started online goes offline while the app is open (iPhone
// Airplane Mode: navigator.onLine stays true and requests hang). Opening Collection must show the
// saved cards, not an endless spinner; a page that was never cached shows its normal state; and the
// network coming back brings fresh data and removes the "saved data" label.

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}
const SAVED_NAMES = ['Alpha Saved Card', 'Beta Saved Card', 'Gamma Saved Card']
const FRESH_NAMES = ['Alpha Saved Card', 'Delta Fresh Card']

const card = (name, index) => ({
  id: `saved-${index}_en`,
  card_id: `saved-${index}_en`,
  name,
  number: String(index + 1).padStart(3, '0'),
  set_id: 'saved-set_en',
  set_name: 'Saved Set',
  set_ref: { id: 'saved-set_en', name: 'Saved Set', abbreviation: 'SAV' },
  rarity: 'Common',
  supertype: 'Pokemon',
  types: ['Lightning'],
  attacks: [],
  price_market: 1,
  price_trend: 1,
  variants_normal: true,
})

const collectionOf = names => names.map((name, index) => ({
  id: index + 1,
  card_id: `saved-${index}_en`,
  quantity: 1,
  variant: 'Normal',
  condition: 'NM',
  lang: 'en',
  added_at: '2026-09-12T12:00:00',
  card: card(name, index),
}))

// `state.hang` never answers (Airplane Mode on iPhone); `state.names` is what the server holds.
async function mockApi(context, state) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    if (state.hang) return new Promise(() => {})
    const path = new URL(route.request().url()).pathname
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: ada })
    if (path === '/api/collection/') return route.fulfill({ json: collectionOf(state.names) })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: ['en'] })
    if (path === '/api/dashboard/') return route.fulfill({ json: { recent_additions: [], top_cards: [] } })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    if (path.startsWith('/api/images/') || path.startsWith('/api/pokedex/')) return route.fulfill({ status: 404, json: {} })
    return route.fulfill({ json: [] })
  })
}

const savedQueries = (page, userId) => page.evaluate(async id => {
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
}, userId)

// A card's name is its text or, when its picture is the fallback, the picture's alt text.
const cardNamed = (page, name) => page.getByText(name).or(page.getByAltText(name))

const sidebar = page => page.getByTestId('sidebar-nav')
const banner = page => page.getByTestId('offline-banner')

// A previous session opens Collection online, so the read cache is saved; a new session starts on Home.
async function startOnlineOnHome(page, context, state) {
  await mockApi(context, state)
  await page.addInitScript(user => {
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('user', JSON.stringify(user))
  }, ada)
  await page.goto('/collection')
  for (const name of SAVED_NAMES) await expect(cardNamed(page, name).first()).toBeVisible()
  // The record is written 5 s after the first successful fetch.
  await expect(async () => expect(await savedQueries(page, ada.id)).toContain('collection')).toPass({ timeout: 20000 })

  await page.goto('/')
  await expect(page.getByTestId('nav-title')).toHaveText('Home')
  await expect(banner(page)).toHaveCount(0)
  expect(await page.evaluate(() => navigator.onLine)).toBe(true)
}

test.describe('going offline while the app is open', () => {
  test.setTimeout(120000)

  test('Collection shows the saved cards instead of an endless spinner, and fresh data replaces them when the network is back', async ({ page, context }) => {
    const state = { names: SAVED_NAMES, hang: false }
    await startOnlineOnHome(page, context, state)

    state.hang = true
    await sidebar(page).getByRole('link', { name: 'Cards', exact: true }).click()
    await expect(page.getByTestId('nav-title')).toHaveText('Collection')

    // The banner follows (a request pending for 5 s, then two failed probes), and the saved data comes back.
    await expect(banner(page)).toBeVisible({ timeout: 30000 })
    for (const name of SAVED_NAMES) await expect(cardNamed(page, name).first()).toBeVisible({ timeout: 10000 })
    await expect(page.locator('.skeleton')).toHaveCount(0)
    await expect(page.getByTestId('stale-data-label')).toContainText('Showing saved data from')

    // The network is back: fresh data replaces the saved copies and the label goes.
    state.names = FRESH_NAMES
    state.hang = false
    await expect(cardNamed(page, 'Delta Fresh Card').first()).toBeVisible({ timeout: 40000 })
    await expect(cardNamed(page, 'Beta Saved Card')).toHaveCount(0)
    await expect(banner(page)).toHaveCount(0)
    await expect(page.getByTestId('stale-data-label')).toHaveCount(0)
  })

  test('a page that was never cached shows its normal state, not an endless spinner', async ({ page, context }) => {
    const state = { names: SAVED_NAMES, hang: false }
    await startOnlineOnHome(page, context, state)

    state.hang = true
    await sidebar(page).getByRole('link', { name: 'Wishlist', exact: true }).click()
    await expect(page.getByTestId('nav-title')).toHaveText('Collection')
    // Its request hangs: the loading skeleton is there at first and goes once the app knows it is offline.
    await expect(banner(page)).toBeVisible({ timeout: 30000 })
    await expect(page.locator('.skeleton')).toHaveCount(0, { timeout: 10000 })
    await expect(page.getByTestId('stale-data-label')).toBeVisible()
  })

  test('a page opened after the app already knows it is offline shows the saved data at once', async ({ page, context }) => {
    const state = { names: SAVED_NAMES, hang: false }
    await startOnlineOnHome(page, context, state)

    state.hang = true
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))) // the monitor probes on its own
    await expect(banner(page)).toBeVisible({ timeout: 30000 })

    await sidebar(page).getByRole('link', { name: 'Cards', exact: true }).click()
    for (const name of SAVED_NAMES) await expect(cardNamed(page, name).first()).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.skeleton')).toHaveCount(0)
  })

  test('data this session already holds is not replaced by the saved copy', async ({ page, context }) => {
    const state = { names: SAVED_NAMES, hang: false }
    await startOnlineOnHome(page, context, state)

    // This session loads Collection with newer data than the saved record, then goes offline.
    state.names = FRESH_NAMES
    await sidebar(page).getByRole('link', { name: 'Cards', exact: true }).click()
    await expect(cardNamed(page, 'Delta Fresh Card').first()).toBeVisible()
    state.hang = true
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(banner(page)).toBeVisible({ timeout: 30000 })
    await expect(cardNamed(page, 'Delta Fresh Card').first()).toBeVisible()
    await expect(cardNamed(page, 'Beta Saved Card')).toHaveCount(0)
  })
})
