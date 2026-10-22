import { expect, test } from '@playwright/test'
import { seedCardDb, seedPictures, seedReadCache } from './fixtures/startup-data.js'

// Offline cold start (F14c). The iPhone keeps requests pending when it is offline instead of failing
// them, and navigator.onLine stays true: every API request here hangs for ever. The device has the
// worst realistic saved data: a read cache near its cap with every page saved, a card database of
// 30,000 cards over 200 sets, and downloaded pictures. Chromium runs 4x CPU-throttled.

const admin = { id: 1, username: 'admin', role: 'admin', avatar_id: null, must_change_password: false }
const SPLASH_BUDGET_MS = Number(process.env.STARTUP_SPLASH_BUDGET_MS || 1000)
const HEALTH_OK = { status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'] }

async function mockApi(context, state) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    if (state.offline) return new Promise(() => {}) // hangs, like iOS offline
    const path = new URL(route.request().url()).pathname
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: admin })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/dashboard/') return route.fulfill({ json: { recent_additions: [], top_cards: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    // Never answers: a manifest that says "off" would make the app delete the seeded card database.
    if (path === '/api/offline/carddb/manifest') return new Promise(() => {})
    if (path.startsWith('/api/images/')) return route.fulfill({ status: 404, json: {} })
    return route.fulfill({ json: [] })
  })
}

// Runs before the page's own scripts on the measured load: marks launch (0), first paint, the first
// moment the splash cover / splash exists, and when the app is interactive, and records every frame's
// background so a white frame can be told apart.
function installProbe() {
  const probe = { frames: [], marks: {}, whiteFrames: [] }
  window.__startup = probe
  const mark = (name) => { if (probe.marks[name] === undefined) probe.marks[name] = Math.round(performance.now()) }
  const isWhite = (color) => /^rgb\(\s*(2[4-5]\d)\s*,\s*(2[4-5]\d)\s*,\s*(2[4-5]\d)\s*\)$/.test(color) || color === 'rgb(255, 255, 255)'
  const transparent = (color) => color === 'rgba(0, 0, 0, 0)' || color === 'transparent'
  const tick = () => {
    const html = document.documentElement
    const body = document.body
    if (html && body) {
      const htmlBg = getComputedStyle(html).backgroundColor
      const bodyBg = getComputedStyle(body).backgroundColor
      // What the viewer sees behind the app: body paints over html; the canvas takes html's (or body's) colour.
      const effective = !transparent(bodyBg) ? bodyBg : (!transparent(htmlBg) ? htmlBg : 'rgb(255, 255, 255)')
      const covered = Boolean(document.querySelector('[data-testid="launch-cover"], [data-testid="launch-splash"]'))
      const t = Math.round(performance.now())
      probe.frames.push({ t, effective, covered })
      if (isWhite(effective)) probe.whiteFrames.push({ t, effective, covered })
      if (document.querySelector('[data-testid="launch-cover"]')) mark('cover')
      if (document.querySelector('[data-testid="launch-splash"]')) mark('splash')
      if (document.querySelector('[data-testid="tab-bar"], #root nav, #root [role="navigation"]')) mark('interactive')
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      if (entry.name === 'first-paint') probe.marks.firstPaint = Math.round(entry.startTime)
      if (entry.name === 'first-contentful-paint') probe.marks.firstContentfulPaint = Math.round(entry.startTime)
    }
  }).observe({ type: 'paint', buffered: true })
}

test.describe('offline cold start with large saved data', () => {
  test.setTimeout(240000)

  test('the splash shows fast and no frame is white', async ({ page, context, browserName }, testInfo) => {
    const state = { offline: false }
    await mockApi(context, state)
    await page.addInitScript(() => {
      localStorage.setItem('pc.splash.e2e', '1') // lets an automated browser see the splash
      if (!sessionStorage.getItem('pc-test-seeded')) {
        sessionStorage.setItem('pc-test-seeded', '1')
        localStorage.setItem('token', 'test-token')
        localStorage.setItem('user', JSON.stringify({ id: 1, username: 'admin', role: 'admin', avatar_id: null, must_change_password: false }))
      }
    })

    // Online first: the app writes the auth snapshot its offline start relies on.
    await page.goto('/')
    await expect.poll(() => page.evaluate(() => localStorage.getItem('pc.auth.snapshot'))).not.toBeNull()
    await seedReadCache(page, admin.id)
    await seedCardDb(page)
    await seedPictures(page)

    state.offline = true
    await page.addInitScript(installProbe)
    let cdp = null
    if (browserName === 'chromium') {
      cdp = await context.newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    }
    const manifestRequests = []
    page.on('request', request => { if (request.url().includes('/api/offline/carddb/manifest')) manifestRequests.push(request.url()) })
    await page.goto('about:blank')
    await page.goto('/')
    await page.waitForFunction(() => window.__startup?.marks.interactive !== undefined, null, { timeout: 60000 }).catch(async error => {
      const seen = await page.evaluate(() => ({ marks: window.__startup?.marks, root: document.getElementById('root')?.innerHTML.slice(0, 600) }))
      console.log(`STARTUP-DEBUG ${JSON.stringify(seen)}`)
      throw error
    })
    // Let the splash finish its reveal frames; the early frames are what matter.
    await page.waitForTimeout(5000)
    const result = await page.evaluate(() => window.__startup)
    if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })

    const runs = []
    for (const frame of result.frames) {
      const last = runs[runs.length - 1]
      if (last && last.covered === frame.covered) last.to = frame.t
      else runs.push({ covered: frame.covered, from: frame.t, to: frame.t })
    }
    console.log(`COVERAGE ${JSON.stringify(runs)}`)
    const timings = { browser: browserName, ...result.marks, whiteFrames: result.whiteFrames.length, frames: result.frames.length }
    console.log(`STARTUP ${JSON.stringify(timings)}`)
    await testInfo.attach('startup-timings', { body: JSON.stringify(timings, null, 2), contentType: 'application/json' })

    const visibleAt = result.marks.splash ?? Infinity
    expect(visibleAt, 'the splash (or its black cover) is on screen').toBeLessThan(SPLASH_BUDGET_MS)
    expect(result.whiteFrames, 'no frame has a white background').toEqual([])
    // The splash never goes away and comes back (the whole tree used to unmount while the saved data loaded).
    const firstCovered = result.frames.findIndex(frame => frame.covered)
    const gap = result.frames.filter((frame, index) => index > firstCovered && frame.t <= result.marks.interactive && !frame.covered)
    expect(gap, 'the splash stays up from its first frame until the app is interactive').toEqual([])
    expect(result.marks.interactive, 'the app is interactive with the splash still running').toBeLessThan(browserName === 'chromium' ? 3000 : 5000)
    // Offline, the card database does not try to sync: its manifest request would only hang.
    expect(manifestRequests).toEqual([])

    // The seeded card database is the version 1 one deployed phones have: the app upgraded it on this
    // offline cold start, and the offline Sets page reads the seeded series from it (the read cache only
    // knows the series "Fixture").
    await page.goto('/sets')
    await expect(page.getByText('Series 3').first()).toBeVisible({ timeout: 30000 })
    expect(await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('pokecollector-carddb')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const version = db.version
      db.close()
      return version
    })).toBeGreaterThanOrEqual(2)
  })
})
