import { expect, test } from '@playwright/test'
import { card, deck } from './fixtures/pages.js'

// Owner feedback F12: every page of the app opens offline. A page opened before shows its saved copy
// with the saved-data line; a page never opened shows its normal state plus one short note; an action
// that needs the server is refused at once with a short note. Both ways of going offline: a fresh
// launch with no connection, and mid-session (iPhone Airplane Mode: navigator.onLine stays true and
// requests hang).

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}

const SETS = [
  { id: 'base1_en', name: 'Base Set Marker', series: 'Base', series_id: 'base', release_date: '1999-01-09', total: 4, owned_count: 1, lang: 'en', abbreviation: 'BS', is_new: false },
  { id: 'sv1_en', name: 'Scarlet Marker', series: 'Scarlet & Violet', series_id: 'sv', release_date: '2023-03-31', total: 10, owned_count: 4, lang: 'en', abbreviation: 'SVI', is_new: false },
]
const CHECKLIST = {
  set: { id: 'base1_en', name: 'Base Set Marker', lang: 'en', series: 'Base', total: 4, release_date: '1999-01-09', abbreviation: 'BS' },
  cards: [{
    ...card(7, { name: 'Checklist Marker Card', set_id: 'base1_en' }),
    owned: false, owned_quantity: 0, quantity: 0, owned_variants: [], owned_items: [], wishlisted: false,
  }],
}
const POKEDEX = {
  entries: [{
    entry_id: '25', dex_id: 25, display_number: '#025', name_en: 'Pikachu Marker', name_de: 'Pikachu', generation: 1,
    owned: false, owned_cards: 0, available_printings: 3, sprite_url: '', artwork_url: '',
  }],
  summary: { total: 1025, owned: 10, missing: 1015 },
}

// `state.hang` never answers; `state.offline` fails every request at once.
async function mockApi(context, state) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    if (state.hang) return new Promise(() => {})
    if (state.offline) return route.abort('connectionrefused')
    const path = new URL(route.request().url()).pathname
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: ada })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: { languages: [{ code: 'en', name: 'English' }] } })
    if (path === '/api/dashboard/') return route.fulfill({ json: { total_cards: 4242, owned_sets: 17, recent_additions: [], top_cards: [] } })
    if (path === '/api/sets/') return route.fulfill({ json: SETS })
    if (path === '/api/sets/base1_en/checklist') return route.fulfill({ json: CHECKLIST })
    if (path === '/api/decks/1') return route.fulfill({ json: deck })
    if (path === '/api/pokedex' || path === '/api/pokedex/') return route.fulfill({ json: POKEDEX })
    if (path === '/api/analytics/trades-summary') return route.fulfill({ json: { trade_count: 0 } })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    if (path.startsWith('/api/images/') || path.startsWith('/api/pokedex/images/')) return route.fulfill({ status: 404, json: {} })
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

// Every page of this list is opened online first; `marker` is something only its saved data shows.
const PAGES = [
  { path: '/sets', title: 'Sets', marker: 'Scarlet & Violet' },
  { path: '/sets/language/en/series/base', title: 'Sets', marker: 'Base Set Marker' },
  { path: '/sets/base1_en', title: 'Base Set Marker', marker: 'Checklist Marker Card' },
  { path: '/decks/1', title: 'Card Lists', marker: 'Visual Practice Deck' },
  { path: '/analytics', title: 'Analytics' },
  { path: '/settings', title: 'Settings' },
]

const text = (page, value) => page.getByText(value).or(page.getByAltText(value)).first()
const navigateInApp = (page, path) => page.evaluate(target => {
  window.history.pushState({}, '', target)
  window.dispatchEvent(new PopStateEvent('popstate'))
}, path)

async function expectSavedPage(page, entry) {
  await expect(page.getByTestId('offline-unavailable')).toHaveCount(0)
  await expect(page.getByTestId('not-saved-note')).toHaveCount(0)
  await expect(page.locator('.skeleton')).toHaveCount(0)
  if (entry.marker) await expect(text(page, entry.marker)).toBeVisible({ timeout: 10000 })
  else await expect(page.getByTestId('nav-title')).toHaveText(entry.title)
}

async function openEverythingOnline(page, context, state) {
  await mockApi(context, state)
  await page.addInitScript(user => {
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('user', JSON.stringify(user))
  }, ada)
  await page.goto('/')
  await expect(page.getByTestId('nav-title')).toHaveText('Home')
  for (const entry of PAGES) {
    await navigateInApp(page, entry.path)
    if (entry.marker) await expect(text(page, entry.marker)).toBeVisible({ timeout: 15000 })
    else await expect(page.getByTestId('nav-title')).toHaveText(entry.title, { timeout: 15000 })
  }
  // The record is written 5 s after the first successful fetch, and again after the later ones.
  await expect(async () => {
    const saved = await savedQueries(page, ada.id)
    for (const key of ['sets', 'set-checklist', 'deck']) expect(saved).toContain(key)
  }).toPass({ timeout: 25000 })
  await page.waitForTimeout(6000)
}

test.describe('every page opens offline', () => {
  test.setTimeout(240000)

  test('a fresh launch with no connection shows each saved page, and a never-opened page shows its note', async ({ page, context }) => {
    const state = { offline: false }
    await openEverythingOnline(page, context, state)

    state.offline = true
    for (const entry of PAGES) {
      await page.goto(entry.path)
      await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 20000 })
      await expectSavedPage(page, entry)
      await expect(page.getByTestId('stale-data-label')).toContainText('Showing saved data from')
    }

    // The Pokédex was never opened (the sign-in prefetch does not cover it): its normal page plus one short line,
    // not "This page isn't available offline".
    await page.goto('/pokedex')
    await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 20000 })
    await expect(page.getByTestId('not-saved-note')).toContainText('Not saved for offline yet. Open it once while online.')
    await expect(page.getByTestId('offline-unavailable')).toHaveCount(0)
    await expect(page.getByTestId('nav-title')).toHaveText('Pokédex')
  })

  test('mid-session with requests that hang: each saved page opens from its copy, a never-opened one shows its note', async ({ page, context }) => {
    const state = { offline: false }
    await openEverythingOnline(page, context, state)

    // A new session starts online on Home, then the connection dies without the device noticing.
    await page.goto('/')
    await expect(page.getByTestId('nav-title')).toHaveText('Home')
    expect(await page.evaluate(() => navigator.onLine)).toBe(true)
    state.hang = true
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))) // the monitor probes on its own
    await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 30000 })

    for (const entry of PAGES) {
      await navigateInApp(page, entry.path)
      await expectSavedPage(page, entry)
    }

    await navigateInApp(page, '/pokedex')
    await expect(page.getByTestId('not-saved-note')).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('offline-unavailable')).toHaveCount(0)
    await expect(page.locator('.skeleton')).toHaveCount(0)
  })

  test('an action that needs the server is refused at once with a short note, never a spinner', async ({ page, context }) => {
    const state = { offline: false }
    await openEverythingOnline(page, context, state)

    await page.goto('/')
    await expect(page.getByTestId('nav-title')).toHaveText('Home')
    state.hang = true
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 30000 })

    await navigateInApp(page, '/decks/1')
    await expect(text(page, 'Visual Practice Deck')).toBeVisible({ timeout: 10000 })
    await page.getByRole('button', { name: 'Card list actions' }).click()
    await page.getByRole('menuitem', { name: /Duplicate/ }).click()
    await expect(page.getByText("Needs a connection. Try again when you're back online.")).toBeVisible({ timeout: 3000 })
    await expect(page).toHaveURL(/\/decks\/1$/)
  })
})
