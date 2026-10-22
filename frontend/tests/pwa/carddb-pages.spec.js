import { expect, test } from '@playwright/test'

// F13b: with the card database downloaded, sets, a set's cards and Search work offline, including a set
// that was never opened online. With the card database switched off, a never-opened page keeps F12's
// behaviour (its normal state plus the "not saved yet" line).

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}

const FIELDS = ['id', 'tcg_card_id', 'name', 'set_id', 'number', 'rarity', 'supertype', 'hp', 'types', 'dex_ids', 'images_small', 'lang']
const row = (tcg, number, name) => [`${tcg}-${number}_en`, `${tcg}-${number}`, name, tcg, number, 'Common', 'Pokémon', '70', ['Lightning'], [877], null, 'en']
const setRow = (id, tcg, name, abbreviation, release) => ({
  id, tcg_set_id: tcg, name, series: 'Fixture Series', series_id: 'fixture', abbreviation, release_date: release, total: 3, lang: 'en',
})
const SETS = {
  pbl_en: { v: 1, set: setRow('pbl_en', 'pbl', 'Perilous Bloom', 'PBL', '2026-08-01'), fields: FIELDS, cards: [row('pbl', '117', 'Morpeko'), row('pbl', '118', 'Morpeko'), row('pbl', '9', 'Pikachu')] },
  svi_en: { v: 1, set: setRow('svi_en', 'sv1', 'Scarlet Fixture', 'SVI', '2023-03-31'), fields: FIELDS, cards: [row('sv1', '117', 'Morpeko'), row('sv1', '2', 'Charizard')] },
}
const MANIFEST = {
  enabled: true,
  format: 1,
  languages: {
    en: {
      hash: 'lang-hash-1',
      prices_hash: 'prices-hash-1',
      prices_updated_at: '2026-10-20T10:00:00',
      prices_bytes: 20,
      set_count: 2,
      card_count: 5,
      bytes: 300,
      sets: [{ id: 'pbl_en', hash: 'h1', cards: 3, bytes: 150 }, { id: 'svi_en', hash: 'h2', cards: 2, bytes: 150 }],
    },
  },
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
    if (path === '/api/offline/carddb/manifest') return route.fulfill({ json: MANIFEST })
    if (path.startsWith('/api/offline/carddb/sets/en/')) {
      const payload = SETS[path.split('/').pop()]
      return payload ? route.fulfill({ json: payload, headers: { ETag: '"x"' } }) : route.fulfill({ status: 404, json: {} })
    }
    if (path === '/api/offline/carddb/prices/en') {
      return route.fulfill({ json: { v: 1, fields: ['price_market', 'price_low'], rows: [['pbl-117_en', 4.5, 3.2]] } })
    }
    if (path === '/api/collection/') {
      return route.fulfill({ json: state.collection ?? [] })
    }
    if (path.startsWith('/api/images/') || path.startsWith('/api/pokedex/')) return route.fulfill({ status: 404, json: {} })
    return route.fulfill({ json: [] })
  })
}

const storedSets = page => page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('pokecollector-carddb')
    request.onupgradeneeded = () => request.transaction.abort()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch(() => null)
  if (!db) return []
  const rows = await new Promise((resolve, reject) => {
    const request = db.transaction('setIndex').objectStore('setIndex').getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return rows.map(item => item.setId).sort()
})
// WebKit sometimes interrupts a navigation that starts while the app is still settling: retry once.
async function open(page, url) {
  try {
    await page.goto(url)
  } catch (error) {
    if (!/interrupted/i.test(String(error))) throw error
    await page.goto(url)
  }
}
const prefsOff = page => page.addInitScript(() => localStorage.setItem('pc-carddb-prefs', JSON.stringify({ enabled: false })))

async function downloadDatabase(page, context, state) {
  await mockApi(context, state)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(user => {
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('user', JSON.stringify(user))
  }, ada)
  await page.goto('/profile')
  await expect(async () => {
    expect(await storedSets(page)).toEqual(['pbl_en', 'svi_en'])
  }).toPass({ timeout: 30000 })
}

test.describe('offline pages read the card database', () => {
  test.setTimeout(120000)

  test('a set never opened online opens offline with its cards and prices date', async ({ page, context }) => {
    const state = { offline: false }
    await downloadDatabase(page, context, state)
    state.offline = true

    await open(page, '/sets')
    await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 20000 })
    await expect(page.getByText('Fixture Series').first()).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('not-saved-note')).toHaveCount(0)

    // The series page lists the sets, none of which was ever opened online.
    await page.getByRole('link', { name: /Fixture Series/ }).first().click()
    await expect(page.getByText('Perilous Bloom').first()).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('Scarlet Fixture').first()).toBeVisible()

    await open(page, '/sets/pbl_en')
    await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 20000 })
    await expect(page.getByText('Morpeko').first()).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('Pikachu').first()).toBeVisible()
    await expect(page.getByTestId('prices-from-note')).toContainText('Prices from')
    await expect(page.getByTestId('not-saved-note')).toHaveCount(0)
    await expect(page.getByTestId('offline-unavailable')).toHaveCount(0)
    // The collection was never loaded on this device: owned figures are unknown, not "0 of 3".
    await expect(page.getByTestId('owned-unavailable')).toContainText('Owned cards unavailable offline')
    await expect(page.getByTestId('set-stat-cards')).toHaveCount(0)
  })

  test('with the collection saved, the owned state of a never-opened set comes from it', async ({ page, context }) => {
    const state = {
      offline: false,
      collection: [{ id: 1, card_id: 'pbl-117_en', quantity: 2, variant: 'normal', condition: 'NM', lang: 'en', card: { id: 'pbl-117_en', set_id: 'pbl', lang: 'en', name: 'Morpeko' } }],
    }
    await downloadDatabase(page, context, state)
    await open(page, '/collection')
    await expect(page.getByTestId('nav-title')).toHaveText('Collection')
    await page.waitForTimeout(7000) // the read cache saves its record 5 s after a fetch
    state.offline = true

    await open(page, '/sets/pbl_en')
    await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 20000 })
    await expect(page.getByTestId('set-stat-cards')).toContainText('1 of 3', { timeout: 15000 })
    await expect(page.getByTestId('owned-unavailable')).toHaveCount(0)
  })

  test('Search finds "Morpeko 117" and corrects "Morbeko" offline', async ({ page, context }) => {
    const state = { offline: false }
    await downloadDatabase(page, context, state)
    state.offline = true

    await open(page, '/search?q=Morpeko%20117%20PBL')
    await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 20000 })
    await expect(page.getByText('1 results').or(page.getByText(/^1\s+\S*results/i)).first()).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('prices-from-note')).toBeVisible()

    await open(page, '/search?q=Morbeko')
    await expect(page.getByTestId('search-corrected')).toContainText('Morbeko', { timeout: 20000 })
    await expect(page.getByTestId('search-corrected')).toContainText('Morpeko')
    await expect(page.getByTestId('not-saved-note')).toHaveCount(0)
  })

  test('with the card database off, a never-opened set keeps the not-saved line', async ({ page, context }) => {
    const state = { offline: false }
    await prefsOff(page)
    await mockApi(context, state)
    await page.addInitScript(user => {
      localStorage.setItem('token', 'test-token')
      localStorage.setItem('user', JSON.stringify(user))
    }, ada)
    await open(page, '/')
    await expect(page.getByTestId('nav-title')).toHaveText('Home')
    state.offline = true

    await open(page, '/sets/pbl_en')
    await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 20000 })

    await expect(page.getByTestId('not-saved-note')).toBeVisible()
    await expect(page.getByTestId('prices-from-note')).toHaveCount(0)
    await expect(page.getByTestId('offline-unavailable')).toHaveCount(0)
  })
})
