import { expect, test } from '@playwright/test'
import { card, deck } from './fixtures/pages.js'
import { seedPictureStore, storedPictureCount } from './fixtures/picture-store.js'

// F15c: right after sign-in every page's data is saved for offline (even for pages never opened), and
// sign-out removes everything of the user bar the card database and its pictures, then reloads.

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const bob = { id: 2, username: 'bob', role: 'user', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}
const NAMES = ['Alpha Saved Card', 'Beta Saved Card', 'Gamma Saved Card']
const BINDER_CARD = 'Binder Marker Card'

const savedCard = (name, index) => card(index + 10, { name, id: `saved-${index}_en`, card_id: `saved-${index}_en` })
const collection = NAMES.map((name, index) => ({
  id: index + 1,
  card_id: `saved-${index}_en`,
  quantity: 1,
  variant: 'Normal',
  condition: 'NM',
  lang: 'en',
  added_at: '2026-09-12T12:00:00',
  card: savedCard(name, index),
}))
const binders = [
  { id: 1, name: 'Prefetch Binder', binder_type: 'collection', card_count: 1, unique_card_count: 1 },
  { id: 2, name: 'Visual Practice Deck', binder_type: 'deck', format: 'Casual', target_size: 40, card_count: 24, unique_card_count: 3 },
]

// `state.hang` never answers (like a stalled iPhone connection); `state.user` answers /api/auth/me.
async function mockApi(context, state) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    if (state.hang) return new Promise(() => {})
    const path = new URL(route.request().url()).pathname
    const isAda = state.user.id === ada.id
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: state.user })
    if (path === '/api/auth/logout') return route.fulfill({ json: {} })
    if (path === '/api/collection/') return route.fulfill({ json: isAda ? collection : [] })
    if (path === '/api/binders/') return route.fulfill({ json: isAda ? binders : [] })
    if (path === '/api/binders/1/cards') {
      return route.fulfill({ json: { binder: binders[0], cards: [{ ...card(30, { name: BINDER_CARD }), quantity: 1, owned_quantity: 1 }], binder_value: 1, unique_count: 1 } })
    }
    if (path === '/api/decks/') return route.fulfill({ json: isAda ? [{ id: 2, name: 'Visual Practice Deck' }] : [] })
    if (path === '/api/decks/2') return route.fulfill({ json: { ...deck, id: 2 } })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: ['en'] })
    if (path === '/api/dashboard/') return route.fulfill({ json: { recent_additions: [], top_cards: [] } })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    if (path.startsWith('/api/images/')) return route.fulfill({ status: 404, json: {} })
    return route.fulfill({ json: [] })
  })
}

// Signs in once per tab (window.name survives the reloads; sign-out clears storage but not the name).
async function signIn(page, user) {
  await page.addInitScript(account => {
    if (window.name === 'pc-seeded') return
    window.name = 'pc-seeded'
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('user', JSON.stringify(account))
  }, user)
}

const readCacheKeys = (page, userId) => page.evaluate(async id => {
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
  return record ? record.state.queries.map(query => JSON.stringify(query.queryKey)) : []
}, userId)

// What is on the device: database names, Cache Storage names, a few localStorage keys.
const deviceState = page => page.evaluate(async () => ({
  databases: (await indexedDB.databases()).map(entry => entry.name).sort(),
  caches: (await caches.keys()).sort(),
  local: ['pc.settings.cache', 'pc.auth.snapshot', 'lastUser', 'pc-carddb-prefs'].filter(key => localStorage.getItem(key) !== null),
}))

const readCacheRecords = page => page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('pokecollector-readcache')
    request.onupgradeneeded = () => request.result.createObjectStore('qc')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const keys = await new Promise((resolve, reject) => {
    const request = db.transaction('qc').objectStore('qc').getAllKeys()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  db.close()
  return keys
})

test.describe('sign-in prefetch and sign-out cleanup', () => {
  test.setTimeout(180000)

  test('pages never opened are saved after sign-in; sign-out removes everything bar the card database; another user sees none', async ({ page, context }) => {
    const state = { hang: false, user: ada }
    await mockApi(context, state)
    await signIn(page, ada)

    // Sign in and stay on Home: no other page is opened.
    await page.goto('/')
    await expect(page.getByTestId('nav-title')).toHaveText('Home')
    await expect(async () => {
      const keys = await readCacheKeys(page, ada.id)
      for (const key of [
        ['collection', {}], ['wishlist'], ['binders'], ['binder-cards', '1', 'price_trend'], ['decks'], ['deck', '2'], ['sets', 'all'],
      ]) expect(keys).toContain(JSON.stringify(key))
    }).toPass({ timeout: 40000 })

    // Things that sign-out must (or must not) remove: viewed pictures, a downloaded picture pack, the card database.
    await seedPictureStore(page, { items: [{ id: 'y_en' }] })
    await page.evaluate(async () => {
      await (await caches.open('pc-images-v1')).put('/api/images/x', new Response('photo'))
      await new Promise(resolve => {
        const request = indexedDB.open('pokecollector-carddb')
        request.onsuccess = () => { request.result.close(); resolve() }
        request.onerror = () => resolve()
      })
      localStorage.setItem('pc-carddb-prefs', '{"enabled":true}')
    })
    const before = await deviceState(page)
    expect(before.databases).toEqual(expect.arrayContaining(['pokecollector-outbox', 'pokecollector-readcache', 'pokecollector-carddb']))
    expect(before.caches).toContain('pc-images-v1')

    // Offline the iPhone way: requests hang, navigator.onLine stays true. The pages come from the saved copies.
    state.hang = true
    for (const [path, marker] of [
      ['/binders', 'Prefetch Binder'],
      ['/binders/1', BINDER_CARD],
      ['/decks/2', 'Visual Practice Deck'],
      ['/collection', NAMES[0]],
    ]) {
      await page.goto(path)
      await expect(page.getByText(marker).or(page.getByAltText(marker)).first()).toBeVisible({ timeout: 30000 })
    }
    await page.goto('/binders')
    await expect(page.getByText('Visual Practice Deck').first()).toBeVisible({ timeout: 30000 })

    // Sign out (back online): everything bar the card database goes, and the page reloads.
    state.hang = false
    await page.goto('/profile')
    await page.getByRole('button', { name: 'Logout' }).click()
    await expect(page).toHaveURL(/\/login/, { timeout: 30000 })
    await expect(async () => {
      const after = await deviceState(page)
      expect(after.databases).not.toContain('pokecollector-outbox')
      expect(after.databases).toContain('pokecollector-carddb')
      expect(after.caches).not.toContain('pc-images-v1')
      expect(after.databases).toContain('pokecollector-pictures')
      expect(await storedPictureCount(page)).toBe(1)
      expect(after.local).toEqual(['pc-carddb-prefs'])
      expect(await readCacheRecords(page)).toEqual([])
    }).toPass({ timeout: 15000 })

    // Another user signs in: none of the first user's data shows, offline or online.
    state.user = bob
    await page.evaluate(account => {
      localStorage.setItem('token', 'test-token')
      localStorage.setItem('user', JSON.stringify(account))
    }, bob)
    await page.goto('/binders')
    await expect(page.getByTestId('nav-title')).toBeVisible()
    await expect(page.getByText('Prefetch Binder')).toHaveCount(0)
    state.hang = true
    await page.goto('/collection')
    await expect(page.getByTestId('nav-title')).toBeVisible({ timeout: 30000 })
    for (const name of NAMES) await expect(page.getByText(name)).toHaveCount(0)
    expect(await readCacheKeys(page, ada.id)).toEqual([])
  })
})
