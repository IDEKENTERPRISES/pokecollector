import { expect, test } from '@playwright/test'

// The offline card database (F13a): the first launch downloads the card data into its own
// IndexedDB, and a second launch with an unchanged manifest fetches nothing but the manifest.

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}

const FIELDS = ['id', 'name', 'set_id', 'number', 'images_small']
const setPayload = (id, name, cards) => ({ v: 1, set: { id, name, series: 'Fixture' }, fields: FIELDS, cards })

const SETS = {
  fix1_en: setPayload('fix1_en', 'Fixture One', [['fix1-1_en', 'Morpeko', 'fix1', '117', null], ['fix1-2_en', 'Pikachu', 'fix1', '002', null]]),
  fix2_en: setPayload('fix2_en', 'Fixture Two', [['fix2-1_en', 'Eevee', 'fix2', '001', null]]),
}

const MANIFEST = {
  enabled: true,
  format: 1,
  languages: {
    en: {
      hash: 'lang-hash-1',
      prices_hash: 'prices-hash-1',
      prices_updated_at: '2026-10-22T10:00:00',
      prices_bytes: 20,
      set_count: 2,
      card_count: 3,
      bytes: 300,
      sets: [
        { id: 'fix1_en', hash: 'set-hash-1', cards: 2, bytes: 150 },
        { id: 'fix2_en', hash: 'set-hash-2', cards: 1, bytes: 150 },
      ],
    },
  },
}

async function mockApi(context, requests) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    requests.push(path)
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
      return route.fulfill({ json: { v: 1, fields: ['price_market'], rows: [['fix1-1_en', 1.5]] } })
    }
    if (path.startsWith('/api/images/') || path.startsWith('/api/pokedex/')) return route.fulfill({ status: 404, json: {} })
    return route.fulfill({ json: [] })
  })
}

// What the card database stored, read straight from its IndexedDB.
const readStored = page => page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('pokecollector-carddb')
    request.onupgradeneeded = () => request.transaction.abort()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch(() => null)
  if (!db) return null
  const all = name => new Promise((resolve, reject) => {
    const request = db.transaction(name).objectStore(name).getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const result = { sets: (await all('setIndex')).map(row => row.setId).sort(), meta: await all('meta'), prices: await all('prices') }
  db.close()
  return result
})

test('the first launch downloads the card data and a second launch fetches only the manifest', async ({ page, context }) => {
  const requests = []
  await mockApi(context, requests)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(user => {
    if (!sessionStorage.getItem('pc-test-seeded')) {
      sessionStorage.setItem('pc-test-seeded', '1')
      localStorage.setItem('token', 'test-token')
      localStorage.setItem('user', JSON.stringify(user))
    }
  }, ada)

  await page.goto('/profile')
  await expect(async () => {
    const stored = await readStored(page)
    expect(stored?.sets).toEqual(['fix1_en', 'fix2_en'])
    expect(stored.meta).toHaveLength(1)
    expect(stored.meta[0]).toMatchObject({ hash: 'lang-hash-1', pricesHash: 'prices-hash-1' })
    expect(stored.prices).toHaveLength(1)
  }).toPass({ timeout: 30000 })

  const dataRequests = () => requests.filter(path => path.startsWith('/api/offline/carddb/') && path !== '/api/offline/carddb/manifest')
  expect(dataRequests().sort()).toEqual([
    '/api/offline/carddb/prices/en',
    '/api/offline/carddb/sets/en/fix1_en',
    '/api/offline/carddb/sets/en/fix2_en',
  ])

  // Second launch: the manifest is unchanged, so nothing but the manifest is fetched.
  requests.length = 0
  await page.reload()
  await expect.poll(() => requests.includes('/api/offline/carddb/manifest'), { timeout: 30000 }).toBe(true)
  await page.waitForTimeout(1500)
  expect(dataRequests()).toEqual([])
})

test('a server that turns the feature off hides the setting and removes the local copy', async ({ page, context }) => {
  const requests = []
  await mockApi(context, requests)
  await page.addInitScript(user => {
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('user', JSON.stringify(user))
  }, ada)
  await page.goto('/profile')
  await expect(async () => {
    expect((await readStored(page))?.sets).toEqual(['fix1_en', 'fix2_en'])
  }).toPass({ timeout: 30000 })

  await context.unroute(url => url.pathname.startsWith('/api/'))
  await mockApi(context, requests)
  await context.route('**/api/offline/carddb/manifest', route => route.fulfill({ status: 404, json: { detail: 'off' } }))
  await page.reload()
  await expect(async () => {
    expect((await readStored(page))?.sets).toEqual([])
  }).toPass({ timeout: 30000 })
})
