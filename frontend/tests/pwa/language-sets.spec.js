import { expect, test } from '@playwright/test'
import { tcgdexLanguageLabel } from '../../src/utils/tcgdexLanguages.js'
import { JA_PREFIX, buildBilingualCarddb } from './fixtures/carddb-bilingual.js'

// F18: choosing Japanese in the Sets language filter, opening a series and a Japanese set must show
// that Japanese set's own cards (never an English set's), and Back to the series list must stay
// responsive. Driven like a person on an iPhone-sized screen (taps and the Back button, no URL typing)
// with about 30,000 cards and 300 sets in two languages (see fixtures/carddb-bilingual.js): the same
// catalogue ids and series exist in en and ja, some sets are Japanese only, and the last Japanese sets
// have no native cards yet. Run online (a mock server that answers like the real backend) and offline
// (card database downloaded, requests hang, navigator.onLine stays true). Chromium also runs with the
// CPU throttled 4x; the main thread's longest stall is measured in both browsers.

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const HEALTH_OK = {
  status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'],
}
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

const data = buildBilingualCarddb()
const { dbs, bodies, fields } = data
const at = Object.fromEntries(fields.map((field, index) => [field, index]))
const langOfSetId = id => id.slice(id.lastIndexOf('_') + 1)
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** GET /api/sets/{id}/checklist the way the real backend answers: the set's own rows in its language. */
function checklistOf(setId) {
  const lang = langOfSetId(setId)
  const payload = dbs[lang]?.sets[setId]
  if (!payload) return null
  const set = payload.set
  const cards = payload.cards.map(row => {
    const card = Object.fromEntries(fields.map((field, index) => [field, row[index]]))
    return {
      id: card.id,
      name: card.name,
      tcg_card_id: card.tcg_card_id,
      set_id: card.set_id,
      set_ref: { id: set.id, tcg_set_id: set.tcg_set_id, name: set.name, abbreviation: set.abbreviation, lang },
      number: card.number,
      rarity: card.rarity,
      images_small: card.images_small,
      images_large: card.images_large,
      image_source_lang: card.image_source_lang === card.lang ? null : card.image_source_lang,
      data_source_lang: card.data_source_lang === card.lang ? null : card.data_source_lang,
      owned: false, owned_quantity: 0, owned_variants: [], wishlisted: false, quantity: 0, owned_items: [],
      price_market: null, price_low: null,
      dex_ids: card.dex_ids,
      variants_normal: card.variants_normal, variants_reverse: card.variants_reverse,
      variants_holo: card.variants_holo, variants_first_edition: card.variants_first_edition,
      lang: card.lang,
    }
  })
  return {
    set: { id: set.id, name: set.name, series: set.series, total: set.total, images_symbol: null, images_logo: null, lang },
    cards, owned_count: 0, total_count: cards.length, progress: 0,
  }
}

async function mockApi(context, state) {
  await context.route(url => url.pathname.startsWith('/api/'), async route => {
    // Airplane Mode on an iPhone: the request is neither answered nor refused.
    if (state.offline) return undefined
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: ada })
    if (path === '/api/settings/' && route.request().method() === 'PUT') {
      Object.assign(state.settings, JSON.parse(route.request().postData() || '{}'))
      return route.fulfill({ json: state.settings })
    }
    if (path === '/api/settings/') return route.fulfill({ json: state.settings })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') {
      return route.fulfill({ json: { languages: [{ code: 'en', name: 'English' }, { code: 'ja', name: 'Japanese' }] } })
    }
    if (path === '/api/offline/carddb/manifest') return route.fulfill({ status: 200, contentType: 'application/json', body: bodies.manifest })
    const downloaded = /^\/api\/offline\/carddb\/sets\/(en|ja)\/(.+)$/.exec(path)
    if (downloaded) {
      const body = bodies.sets[downloaded[1]][downloaded[2]]
      return body ? route.fulfill({ status: 200, contentType: 'application/json', body, headers: { ETag: '"x"' } }) : route.fulfill({ status: 404, json: {} })
    }
    const prices = /^\/api\/offline\/carddb\/prices\/(en|ja)$/.exec(path)
    if (prices) return route.fulfill({ status: 200, contentType: 'application/json', body: bodies.prices[prices[1]] })
    // The offline runs must be answered by the card database, so the server's sets are not saved for them.
    if (path === '/api/sets/') {
      if (state.cardDbOnly) return route.fulfill({ status: 404, json: {} })
      const lang = url.searchParams.get('lang') || 'en'
      const langs = lang === 'all' ? ['en', 'ja'] : [lang]
      return route.fulfill({ json: langs.flatMap(code => dbs[code].setList.map(set => ({ ...set, owned_count: 0, is_new: false }))) })
    }
    const checklist = /^\/api\/sets\/([^/]+)\/checklist$/.exec(path)
    if (checklist) {
      if (state.cardDbOnly) return route.fulfill({ status: 404, json: {} })
      const body = checklistOf(decodeURIComponent(checklist[1]))
      return body ? route.fulfill({ json: body }) : route.fulfill({ status: 404, json: { detail: 'Set not found' } })
    }
    if (path === '/api/collection/') return route.fulfill({ json: [] })
    if (path.startsWith('/api/images/card/')) return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL })
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

// How long the main thread stopped answering: a 20 ms heartbeat records its largest gap (it works in
// WebKit, which has no long-task observer), plus long tasks where the browser reports them.
const HEARTBEAT = () => {
  window.__gap = 0
  window.__longTasks = []
  let last = performance.now()
  setInterval(() => {
    const now = performance.now()
    window.__gap = Math.max(window.__gap, now - last - 20)
    last = now
  }, 20)
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.__longTasks.push(Math.round(entry.duration))
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    // not supported (WebKit)
  }
}
const resetStall = page => page.evaluate(() => { window.__gap = 0; window.__longTasks = [] })
const readStall = page => page.evaluate(() => Math.round(Math.max(window.__gap, ...window.__longTasks, 0)))

async function chooseLanguage(page, code) {
  await page.getByRole('button', { name: /Filters/ }).first().click()
  await page.locator('#sets-filter-language').selectOption(code)
  await page.getByRole('button', { name: 'Done' }).click()
}

/** The series tile of a set's series in the language the person is looking at (with "All" there is one per language). */
function seriesTile(page, set, wanted) {
  const links = page.getByTestId('series-grid').getByRole('link', { name: new RegExp(escape(set.series)) })
  return wanted === 'all' ? links.filter({ hasText: tcgdexLanguageLabel('ja') }).first() : links.first()
}

/**
 * Taps Back and returns how long the page took, inside the page, from the tap to the target page being
 * painted (two frames after it is in the DOM). Playwright's own click and polling time is not in it.
 */
async function tapBack(page, targetTestId) {
  const measured = page.evaluate(testId => new Promise(resolve => {
    document.querySelector('[data-testid="nav-back"]').addEventListener('click', () => {
      const started = performance.now()
      const check = () => {
        if (document.querySelector(`[data-testid="${testId}"]`)) {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(performance.now() - started))))
        } else {
          requestAnimationFrame(check)
        }
      }
      check()
    }, { once: true, capture: true })
  }), targetTestId)
  await page.getByTestId('nav-back').click()
  return measured
}

/** What the set page shows: the card names and the pictures they ask for. */
async function setPageCards(page) {
  await expect(page.getByRole('button', { name: /^Add / }).first()).toBeVisible({ timeout: 30000 })
  // Online the pictures load a moment after the cards; offline their requests hang and none arrive.
  await page.waitForFunction(() => document.querySelector('img[src*="/api/images/card/"]'), null, { timeout: 5000 }).catch(() => {})
  return page.evaluate(() => ({
    names: [...document.querySelectorAll('button[aria-label^="Add "]')].map(node => node.getAttribute('aria-label').slice(4)),
    pictures: [...document.querySelectorAll('img')].map(img => img.getAttribute('src') || '').filter(src => src.includes('/api/images/card/')),
  }))
}

for (const mode of ['online', 'offline']) {
  test.describe(`language sets, ${mode}`, () => {
    test.setTimeout(240000)

    /** Signed in, both databases downloaded, the Sets page open (series view), Airplane Mode for the offline runs. */
    async function start({ page, context, browserName }) {
      const state = { offline: false, cardDbOnly: mode === 'offline', settings: { language: 'en', currency: 'EUR' } }
      await mockApi(context, state)
      await page.setViewportSize({ width: 390, height: 844 })
      await page.addInitScript(HEARTBEAT)
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
        expect(stored.sets).toBe(data.setTotal)
        expect(stored.meta).toEqual(expect.arrayContaining(['en', 'ja']))
      }).toPass({ timeout: 180000 })
      if (browserName === 'chromium') {
        const cdp = await context.newCDPSession(page)
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
      }
      const tabBar = page.getByTestId('tab-bar')
      await tabBar.getByRole('link', { name: 'Search' }).click()
      await expect(page.getByTestId('search-browse')).toBeVisible({ timeout: 20000 })
      await page.getByTestId('browse-sets').click()
      if (mode === 'offline') {
        // The person has opened Sets while online before (the language list is saved for offline use);
        // then Airplane Mode: requests hang, the device still says it is online.
        await expect(page.getByRole('button', { name: /Filters/ }).first()).toBeVisible({ timeout: 20000 })
        await page.waitForTimeout(7000)
        state.offline = true
        expect(await page.evaluate(() => navigator.onLine)).toBe(true)
        await tabBar.getByRole('link', { name: 'Home' }).click()
        await tabBar.getByRole('link', { name: 'Search' }).click()
      }
      await expect(page.getByTestId('series-grid').getByRole('link').first()).toBeVisible({ timeout: 40000 })
    }

    for (const wanted of ['ja', 'all']) {
      test(`${wanted}: a Japanese set shows its own cards and Back to the series stays responsive`, async ({ page, context, browserName }) => {
        await start({ page, context, browserName })
        const timings = {}
        const landmark = data.ja.landmark
        const landmarkSet = data.ja.setList.find(set => set.id === landmark.setId)

        await chooseLanguage(page, wanted)
        await expect(page.getByTestId('series-grid')).toBeVisible()
        await page.waitForTimeout(1500) // a person looks at the list before tapping
        if (wanted === 'all') {
          // The same series exists in both languages: each has its own tile.
          await expect(page.getByTestId('series-grid').getByRole('link', { name: new RegExp(escape(landmark.series)) })).toHaveCount(2)
        }
        await seriesTile(page, landmarkSet, wanted).click()
        await expect(page.getByTestId('sets-grid')).toBeVisible({ timeout: 20000 })

        // The language the person chose survives into the series page: only Japanese sets are listed.
        const tileIds = await page.getByTestId('set-tile').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-scroll-anchor')))
        expect(tileIds.length).toBeGreaterThan(0)
        expect(tileIds.filter(id => !id.endsWith('_ja')), 'sets of another language on a Japanese series page').toEqual([])

        // The Japanese set: every card is that set's own.
        await page.getByRole('button', { name: landmark.setName, exact: true }).click()
        await expect(page).toHaveURL(new RegExp(`/sets/${escape(landmark.setId)}$`))
        const shown = await setPageCards(page)
        const expectedNames = new Set(data.ja.sets[landmark.setId].cards.map(row => row[at.name]))
        for (const name of shown.names) expect(expectedNames.has(name), `${name} is not a card of ${landmark.setId}`).toBe(true)
        if (mode === 'online') expect(shown.pictures.length).toBeGreaterThan(0) // offline the pictures never arrive
        for (const src of shown.pictures) expect(src, 'a picture of another language').toMatch(new RegExp(`/api/images/card/${landmark.tcgId}-\\d+_ja/`))

        // Back to the series page: must answer at once, and a different tile must open on tap.
        await resetStall(page)
        timings.backToSeries = await tapBack(page, 'sets-grid')
        await expect(page.getByTestId('sets-grid')).toBeVisible({ timeout: 5000 })
        const tapStart = Date.now()
        await page.getByTestId('set-tile').nth(1).getByRole('button').first().click()
        await expect(page).toHaveURL(/\/sets\/[^/]+_ja$/, { timeout: 5000 })
        timings.tapAfterBack = Date.now() - tapStart
        timings.stallAfterBack = await readStall(page)
        await page.getByTestId('nav-back').click()
        await expect(page.getByTestId('sets-grid')).toBeVisible({ timeout: 5000 })

        // Forward and back five times: the same set again, every time with its own cards.
        for (let round = 1; round <= 5; round += 1) {
          await page.getByRole('button', { name: landmark.setName, exact: true }).click()
          await expect(page).toHaveURL(new RegExp(`/sets/${escape(landmark.setId)}$`))
          const again = await setPageCards(page)
          for (const name of again.names) expect(expectedNames.has(name), `round ${round}: ${name}`).toBe(true)
          await resetStall(page)
          timings[`back ${round}`] = await tapBack(page, 'sets-grid')
          await expect(page.getByTestId('sets-grid')).toBeVisible({ timeout: 5000 })
          timings[`stall ${round}`] = await readStall(page)
        }

        // Up to the series list, into another series.
        await page.getByTestId('nav-back').click()
        await expect(page.getByTestId('series-grid')).toBeVisible({ timeout: 5000 })
        await resetStall(page)
        const listStart = Date.now()
        await page.getByTestId('series-grid').getByRole('link').nth(1).click()
        await expect(page.getByTestId('sets-grid')).toBeVisible({ timeout: 5000 })
        timings.openAnotherSeries = Date.now() - listStart
        timings.stallAfterSeriesList = await readStall(page)

        console.log(`[${browserName} ${mode} ${wanted}] timings (ms): ${JSON.stringify(timings)}`)
        test.info().annotations.push({ type: 'timings', description: JSON.stringify(timings) })
        // About a second on a slow phone; the CPU-throttled and software-rendered runs get some room.
        for (const [key, value] of Object.entries(timings)) {
          if (key.startsWith('stall')) expect(value, key).toBeLessThan(600)
          else expect(value, key).toBeLessThan(1500)
        }
      })
    }

    test('tapping Back twice in a row from a Japanese set does not freeze the page', async ({ page, context, browserName }) => {
      await start({ page, context, browserName })
      await chooseLanguage(page, 'ja')
      await page.waitForTimeout(1500)
      const landmark = data.ja.landmark
      await seriesTile(page, data.ja.setList.find(set => set.id === landmark.setId), 'ja').click()
      await page.getByRole('button', { name: landmark.setName, exact: true }).click()
      await setPageCards(page)

      // An impatient person: Back, and Back again before the first has finished.
      const back = page.getByTestId('nav-back')
      await back.click()
      await back.click({ timeout: 10000 })
      await expect(page.getByTestId('series-grid')).toBeVisible({ timeout: 10000 })
      // The page still answers: another series opens on tap, and a set after it.
      await page.getByTestId('series-grid').getByRole('link').nth(1).click({ timeout: 10000 })
      await expect(page.getByTestId('sets-grid')).toBeVisible({ timeout: 10000 })
      await page.getByTestId('set-tile').first().getByRole('button').first().click()
      await expect(page).toHaveURL(/\/sets\/[^/]+_ja$/, { timeout: 10000 })
      await setPageCards(page)
    })

    test('a catalogue id in both languages, a Japanese set without native cards, a Japanese-only set', async ({ page, context, browserName }) => {
      await start({ page, context, browserName })
      await chooseLanguage(page, 'ja')
      await page.waitForTimeout(1500)

      const openSet = async set => {
        await seriesTile(page, set, 'ja').click()
        await page.getByRole('button', { name: set.name, exact: true }).click()
        await expect(page).toHaveURL(new RegExp(`/sets/${escape(set.id)}$`))
        return setPageCards(page)
      }
      const backToSeriesList = async () => {
        await page.getByTestId('nav-back').click()
        await expect(page.getByTestId('sets-grid')).toBeVisible({ timeout: 5000 })
        await page.getByTestId('nav-back').click()
        await expect(page.getByTestId('series-grid')).toBeVisible({ timeout: 5000 })
      }

      // fx10 exists in en and ja: the Japanese one must show Japanese cards and pictures.
      const twin = await openSet(data.twin)
      expect(twin.names.length).toBeGreaterThan(0)
      for (const name of twin.names) expect(name.startsWith(JA_PREFIX), `${name} is not Japanese`).toBe(true)
      for (const src of twin.pictures) expect(src).toMatch(/_ja\//)
      await expect(page.getByTestId('fallback-language-note')).toHaveCount(0)
      await backToSeriesList()

      // A Japanese-only set.
      const only = await openSet(data.jaOnly)
      for (const name of only.names) expect(name.startsWith(JA_PREFIX), `${name} is not Japanese`).toBe(true)
      await backToSeriesList()

      // No native cards yet: the English cards stand in, and the page says so instead of passing as Japanese data.
      const borrowed = await openSet(data.fallback)
      expect(borrowed.names.length).toBeGreaterThan(0)
      for (const name of borrowed.names) expect(name.startsWith(JA_PREFIX), `${name} is English stand-in data`).toBe(false)
      for (const src of borrowed.pictures) expect(src).toMatch(/_ja\//)
      await expect(page.getByTestId('fallback-language-note')).toBeVisible()
      await expect(page.getByTestId('set-banner')).toContainText(tcgdexLanguageLabel('ja'))
    })
  })
}
