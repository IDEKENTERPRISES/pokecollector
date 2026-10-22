import { expect, test } from '@playwright/test'
import { buildLargeCarddb } from './fixtures/carddb-large.js'

// F14a: the offline pages at the size an iPhone really has (about 200 sets, 30,000 cards), driven
// like a person (tap tiles, type into the search field, use back and the tab bar), with
// "Airplane Mode" simulated the way iOS behaves: API and picture requests hang and never answer
// while navigator.onLine stays true. Chromium also runs with the CPU throttled 4x.

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}

const db = buildLargeCarddb()
const bodies = {
  manifest: JSON.stringify(db.manifest),
  prices: JSON.stringify(db.prices),
  sets: Object.fromEntries(Object.entries(db.sets).map(([id, payload]) => [id, JSON.stringify(payload)])),
}
const json = body => ({ status: 200, contentType: 'application/json', body })

async function mockApi(context, state) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    // Airplane Mode on an iPhone: the request is neither answered nor refused.
    if (state.offline) return undefined
    const path = new URL(route.request().url()).pathname
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: ada })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: ['en'] })
    if (path === '/api/offline/carddb/manifest') return route.fulfill(json(bodies.manifest))
    if (path.startsWith('/api/offline/carddb/sets/en/')) {
      const body = bodies.sets[path.split('/').pop()]
      return body ? route.fulfill({ ...json(body), headers: { ETag: '"x"' } }) : route.fulfill({ status: 404, json: {} })
    }
    if (path === '/api/offline/carddb/prices/en') return route.fulfill(json(bodies.prices))
    if (path === '/api/collection/') return route.fulfill({ json: [] })
    if (path.startsWith('/api/images/') || path.startsWith('/api/pokedex/')) return route.fulfill({ status: 404, json: {} })
    return route.fulfill({ json: [] })
  })
}

const carddbState = page => page.evaluate(async () => {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('pokecollector-carddb')
    request.onupgradeneeded = () => request.transaction.abort()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }).catch(() => null)
  if (!database) return { sets: 0, meta: [] }
  const read = (store, method) => new Promise((resolve, reject) => {
    const request = database.transaction(store).objectStore(store)[method]()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const result = { sets: (await read('setIndex', 'getAllKeys')).length, meta: await read('meta', 'getAllKeys') }
  database.close()
  return result
})

// Long tasks (main thread blocked for 50 ms or more) seen by the page; Chromium only.
const LONG_TASKS = () => {
  window.__longTasks = []
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration))
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    // not supported (WebKit)
  }
}
const longestTask = (page, since) => page.evaluate(from => Math.max(0, ...(window.__longTasks ?? []).slice(from)), since)
const taskCount = page => page.evaluate(() => (window.__longTasks ?? []).length)

async function timed(label, timings, page, action) {
  const before = await taskCount(page)
  const started = Date.now()
  await action()
  timings[label] = Date.now() - started
  timings[`${label} longest block`] = await longestTask(page, before)
}

test.describe('the offline card database at full size', () => {
  test.setTimeout(240000)

  test('sets, a set, back, the tab bar and search stay responsive offline', async ({ page, context, browserName }) => {
    const state = { offline: false }
    const timings = {}
    await mockApi(context, state)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.addInitScript(LONG_TASKS)
    await page.addInitScript(user => {
      if (!sessionStorage.getItem('pc-test-seeded')) {
        sessionStorage.setItem('pc-test-seeded', '1')
        localStorage.setItem('token', 'test-token')
        localStorage.setItem('user', JSON.stringify(user))
      }
    }, ada)

    await page.goto('/profile')
    await expect(async () => {
      const stored = await carddbState(page)
      expect(stored.sets).toBe(200)
      expect(stored.meta).toContain('en')
    }).toPass({ timeout: 150000 })

    // Airplane Mode: requests hang, the device still says it is online.
    state.offline = true
    if (browserName === 'chromium') {
      const cdp = await context.newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    }
    const tabBar = page.getByTestId('tab-bar')
    const navTitle = page.getByTestId('nav-title')
    const onLine = await page.evaluate(() => navigator.onLine)
    expect(onLine).toBe(true)

    // Search tab -> Browse sets.
    await tabBar.getByRole('link', { name: 'Search' }).click()
    await expect(page.getByTestId('search-browse')).toBeVisible({ timeout: 20000 })
    await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 40000 })
    await timed('sets list', timings, page, async () => {
      await page.getByTestId('browse-sets').click()
      await expect(page.getByTestId('series-grid').getByRole('link').first()).toBeVisible({ timeout: 30000 })
    })

    // A series, then a set that was never opened online: the cards must appear.
    await page.getByTestId('series-grid').getByRole('link', { name: new RegExp(db.landmark.series.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click()
    await expect(page.getByTestId('sets-grid')).toBeVisible({ timeout: 20000 })
    await timed('set page', timings, page, async () => {
      await page.getByRole('button', { name: db.landmark.setName }).first().click()
      await expect(page.getByRole('button', { name: `Add ${db.landmark.name}` })).toBeVisible({ timeout: 30000 })
    })
    await expect(page.getByTestId('prices-from-note')).toContainText('Prices from')

    // Tapping a card whose picture never arrives still opens its details.
    await page.getByRole('button', { name: `Add ${db.landmark.name}` }).dispatchEvent('click')
    await expect(page.getByRole('dialog', { name: db.landmark.name })).toBeVisible({ timeout: 10000 })
    await page.keyboard.press('Escape')

    // Back out of the set, twice, then switch tabs: every tap must work.
    await page.getByTestId('nav-back').click()
    await expect(page).toHaveURL(/\/sets\/series\//)
    await page.getByTestId('nav-back').click()
    await expect(page).toHaveURL(/\/sets$/)
    await tabBar.getByRole('link', { name: 'Collection' }).click()
    await expect(page).toHaveURL(/\/collection/)
    await tabBar.getByRole('link', { name: 'Home' }).click()
    await expect(navTitle).toHaveText('Home')
    await tabBar.getByRole('link', { name: 'Search' }).click()
    await expect(page).toHaveURL(/\/(search|sets)/) // the tab remembers where it was
    await tabBar.getByRole('link', { name: 'Profile' }).click()
    await expect(page).toHaveURL(/\/profile/)

    // An impatient person: open the set again, hit Back three times in a row, then use the tab bar.
    await tabBar.getByRole('link', { name: 'Search' }).click()
    if (!page.url().includes('/sets')) await page.getByTestId('browse-sets').click()
    await page.getByTestId('series-grid').getByRole('link', { name: new RegExp(db.landmark.series.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click()
    await page.getByRole('button', { name: db.landmark.setName }).first().click()
    await expect(page.getByRole('button', { name: `Add ${db.landmark.name}` })).toBeVisible({ timeout: 30000 })
    const back = page.getByTestId('nav-back')
    for (let tap = 0; tap < 3; tap += 1) await back.click({ timeout: 5000 }).catch(() => {})
    await expect(page).not.toHaveURL(/\/sets\/fx/)
    await tabBar.getByRole('link', { name: 'Collection' }).click()
    await expect(page).toHaveURL(/\/collection/)
    await tabBar.getByRole('link', { name: 'Profile' }).click()
    await expect(page).toHaveURL(/\/profile/)

    // Search: type like a person.
    await tabBar.getByRole('link', { name: 'Search' }).click()
    // The tab remembers where it was; tapping it again goes to its root.
    if (page.url().includes('/sets')) await tabBar.getByRole('link', { name: 'Search' }).click()
    await expect(page).toHaveURL(/\/search/)
    const field = page.getByRole('searchbox')
    await expect(field).toBeEnabled()
    await timed('search', timings, page, async () => {
      await field.click()
      await field.pressSequentially(db.landmark.name)
      await field.press('Enter') // the keyboard's Search key
      await expect(page.getByTestId('prices-from-note')).toBeVisible({ timeout: 30000 })
    })
    await field.fill('')
    await field.pressSequentially(`${db.landmark.name.slice(0, -1)}k`) // a typo is corrected like the server does
    await field.press('Enter')
    await expect(page.getByTestId('search-corrected')).toContainText(db.landmark.name, { timeout: 30000 })

    // How long the card database itself took to answer each page's read (tap-to-pixels is above).
    const reads = await page.evaluate(() => performance.getEntriesByName('carddb-read').map(entry => [String(entry.detail?.key ?? '').slice(0, 40), Math.round(entry.duration)]))
    timings.reads = reads
    test.info().annotations.push({ type: 'timings', description: JSON.stringify(timings) })
    console.log(`[${browserName}] timings (ms): ${JSON.stringify(timings)}`)
  })
})
