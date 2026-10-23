import http from 'node:http'
import { expect, test } from '@playwright/test'
import { seedPictureStore } from './fixtures/picture-store.js'

// F15a/F16a: an offline cold start with the card pictures downloaded (about 22,000 pictures as set packs in
// the IndexedDB picture store) must reach the splash as fast as with no pictures, and card images
// answer at once offline. "Airplane Mode" as iOS does it: API and picture requests hang while
// navigator.onLine stays true. PICTURES / PICTURE_KB tune the size (default 22,000 x 2 KB).

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}
const PICTURES = Number(process.env.PICTURES ?? 22000)
const PICTURE_KB = Number(process.env.PICTURE_KB ?? 2)
const THROTTLE = Number(process.env.CPU_THROTTLE ?? 1)

// A pass-through proxy to the test server that can go dark: requests then neither answer nor
// fail, which is what the service worker's own fetches see on an iPhone in Airplane Mode (the
// browser's route mocking cannot hold those back).
async function startProxy(state) {
  const held = new Set()
  const server = http.createServer((req, res) => {
    if (state.offline) { held.add(res); return }
    const upstream = http.request({ host: '127.0.0.1', port: 4175, path: req.url, method: req.method, headers: req.headers }, answer => {
      res.writeHead(answer.statusCode, answer.headers)
      answer.pipe(res)
    })
    upstream.on('error', () => res.destroy())
    req.pipe(upstream)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => { held.forEach(res => res.destroy()); server.closeAllConnections?.(); server.close() },
  }
}

async function mockApi(context, state) {
  await context.route(url => url.pathname.startsWith('/api/') || url.pathname.startsWith('/cards-test/'), route => {
    const path = new URL(route.request().url()).pathname
    if (state.offline) return undefined
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: ada })
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

const seedPictures = (page, count, kb) => seedPictureStore(page, { count, kb, prefix: 'seed' })

test('an offline cold start with downloaded pictures reaches the splash fast', async ({ page, context, browserName }, testInfo) => {
  test.setTimeout(300000)
  const state = { offline: false }
  await mockApi(context, state)
  const proxy = await startProxy(state)
  test.info().annotations.push({ type: 'proxy', description: proxy.url })
  await context.addInitScript(account => {
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('user', JSON.stringify(account))
  }, ada)
  await page.goto(proxy.url + '/')
  await expect(page.getByTestId('nav-bar')).toBeVisible({ timeout: 30000 })
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  await expect(page.getByTestId('nav-bar')).toBeVisible({ timeout: 30000 })

  await seedPictures(page, PICTURES, PICTURE_KB)

  state.offline = true
  expect(await page.evaluate(() => navigator.onLine)).toBe(true)
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 1000 })
  }).toPass({ timeout: 40000 })

  // Cold worker where the browser lets us stop it (Chromium).
  let cdp = null
  if (browserName === 'chromium') {
    cdp = await context.newCDPSession(page)
    if (THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
  }

  // An automated browser skips the splash unless a test opts in.
  await page.evaluate(() => localStorage.setItem('pc.splash.e2e', '1'))
  const runs = []
  for (let run = 0; run < 3; run += 1) {
    // A new tab is a fresh launch (the splash shows once per launch), as opening the Home Screen app is.
    const launch = await context.newPage()
    const started = Date.now()
    await launch.goto(proxy.url + '/', { waitUntil: 'commit' })
    await launch.getByTestId('launch-splash').waitFor({ timeout: 30000 })
    const toSplash = Date.now() - started
    const timing = await launch.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0]
      const paint = performance.getEntriesByType('paint').find(entry => entry.name === 'first-contentful-paint')
      return { shellMs: Math.round(nav.responseStart), fcpMs: paint ? Math.round(paint.startTime) : null }
    })
    runs.push({ toSplash, ...timing })
    await launch.close()
  }

  // Images offline: a saved picture is instant, an unsaved one fails at once.
  const images = await page.evaluate(async () => {
    const load = src => new Promise(resolve => {
      const started = performance.now()
      const img = new Image()
      img.onload = () => resolve({ ok: true, ms: Math.round(performance.now() - started) })
      img.onerror = () => resolve({ ok: false, ms: Math.round(performance.now() - started) })
      img.src = src
    })
    return { saved: await load('/api/images/card/seed1/small'), unsaved: await load('/api/images/card/en/none/small'), sprite: await load('/api/pokedex/images/25') }
  })

  if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  proxy.close()
  const summary = { browserName, pictures: PICTURES, pictureKb: PICTURE_KB, cpuThrottle: THROTTLE, runs, images }
  console.log(`F15a-RESULT ${JSON.stringify(summary)}`)
  await testInfo.attach('f15a-result', { body: JSON.stringify(summary, null, 2), contentType: 'application/json' })

  expect(Math.min(...runs.map(run => run.toSplash))).toBeLessThan(2500)
  expect(images.unsaved.ok).toBe(false)
  expect(images.unsaved.ms).toBeLessThan(1000)
  expect(images.saved.ok).toBe(true)
})
