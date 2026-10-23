import { expect, test } from '@playwright/test'
import {
  HEARTBEAT, ada, carddbState, data, escape, mockApi, readStall, resetStall, setPageCards, tapBack,
} from './fixtures/language-sets-harness.js'

// F19: Sets browsing is language-first: Language -> Series -> Sets. Driven like a person on an iPhone-sized
// screen (taps and the Back button) with about 30,000 cards and 300 sets in two languages (en + ja).
//   - two languages: selection -> Series -> Sets -> set -> Back chain, online and offline
//     (offline: requests hang while navigator.onLine stays true, answered from the card database);
//   - the nav-bar switch changes language in place;
//   - the "Sets open in" setting skips the selection, and Back from there goes to Search;
//   - a server with one language has no selection and no switch;
//   - repeated forward/back with no main-thread stall over a few hundred ms.

const landmarks = { en: data.en.landmark, ja: data.ja.landmark }

async function start({ page, context, browserName }, { offline = false, languages = ['en', 'ja'], settings = {}, waitForDb = true, hideLanguages = false } = {}) {
  const state = { offline: false, cardDbOnly: offline, hideLanguages, languages, settings: { language: 'en', currency: 'EUR', ...settings } }
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
  if (waitForDb) {
    await expect(async () => {
      const stored = await carddbState(page)
      expect(stored.sets).toBe(data.setTotal)
      expect(stored.meta).toEqual(expect.arrayContaining(['en', 'ja']))
    }).toPass({ timeout: 180000 })
  }
  if (browserName === 'chromium') {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  }
  if (offline) {
    state.offline = true
    expect(await page.evaluate(() => navigator.onLine)).toBe(true)
  }
  await page.getByTestId('tab-bar').getByRole('link', { name: 'Search' }).click()
  await expect(page.getByTestId('search-browse')).toBeVisible({ timeout: 20000 })
  if (offline) await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 40000 })
  return state
}

const browseSets = page => page.getByTestId('browse-sets').click()
const seriesGrid = page => page.getByTestId('series-grid')
const seriesTile = (page, series) => seriesGrid(page).getByRole('link', { name: new RegExp(escape(series)) }).first()
const path = page => new URL(page.url()).pathname
// A person waits for the slide to finish before the next tap (taps during a transition are ignored).
const settled = page => page.waitForFunction(() => !document.documentElement.dataset.vt, null, { timeout: 5000 })
const back = async page => {
  await settled(page)
  await page.getByTestId('nav-back').click()
}

async function openLanguage(page, code) {
  await page.getByTestId(`sets-language-${code}`).click()
  await expect(seriesGrid(page).getByRole('link').first()).toBeVisible({ timeout: 40000 })
  await expect(page).toHaveURL(new RegExp(`/sets/language/${code}$`))
}

async function switchLanguage(page, name) {
  await page.getByTestId('sets-language-switch').click()
  await page.getByRole('menuitemradio', { name }).click()
}

async function expectOnlyLanguage(page, code) {
  const ids = await page.getByTestId('set-tile').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-scroll-anchor')))
  expect(ids.length).toBeGreaterThan(0)
  expect(ids.filter(id => !id.endsWith(`_${code}`)), `sets that are not ${code}`).toEqual([])
}

for (const mode of ['online', 'offline']) {
  test.describe(`language-first sets, ${mode}`, () => {
    test.setTimeout(240000)

    test('selection -> Series -> Sets -> set, and Back all the way out', async ({ page, context, browserName }) => {
      await start({ page, context, browserName }, { offline: mode === 'offline' })
      await browseSets(page)

      // The language list is the first screen: both languages, with their set counts.
      await expect(page.getByTestId('sets-languages')).toBeVisible({ timeout: 40000 })
      await expect(page.getByTestId('sets-language-en')).toContainText('English')
      await expect(page.getByTestId('sets-language-ja')).toContainText('Japanese')
      await expect(page.getByTestId('sets-language-ja')).toContainText(/\d+ sets/)
      await expect.poll(() => path(page)).toBe('/sets')
      await expect(page.getByTestId('sets-language-switch')).toHaveCount(0)

      for (const code of ['ja', 'en']) {
        const landmark = landmarks[code]
        await openLanguage(page, code)
        await expect(page.getByTestId('sets-language-switch')).toBeVisible()
        await page.waitForTimeout(1000) // a person looks at the list before tapping
        await seriesTile(page, landmark.series).click()
        await expect(page.getByTestId('sets-grid')).toBeVisible({ timeout: 20000 })
        await expect(page).toHaveURL(new RegExp(`/sets/language/${code}/series/`))
        await expectOnlyLanguage(page, code)

        await page.getByRole('button', { name: landmark.setName, exact: true }).click()
        await expect(page).toHaveURL(new RegExp(`/sets/${escape(landmark.setId)}$`))
        const shown = await setPageCards(page)
        const own = new Set(data[code].sets[landmark.setId].cards.map(row => row[data.fields.indexOf('name')]))
        for (const name of shown.names) expect(own.has(name), `${name} is not a card of ${landmark.setId}`).toBe(true)

        // Back: set -> the series' sets -> the language's series -> the language list.
        await back(page)
        await expect(page.getByTestId('sets-grid')).toBeVisible({ timeout: 10000 })
        await expect.poll(() => path(page)).toMatch(new RegExp(`^/sets/language/${code}/series/`))
        await back(page)
        await expect(seriesGrid(page)).toBeVisible({ timeout: 10000 })
        await expect.poll(() => path(page)).toBe(`/sets/language/${code}`)
        await back(page)
        await expect(page.getByTestId('sets-languages')).toBeVisible({ timeout: 10000 })
        await expect.poll(() => path(page)).toBe('/sets')
      }

      await back(page)
      await expect(page.getByTestId('search-browse')).toBeVisible({ timeout: 10000 })
    })

    test('the switch changes the language in place', async ({ page, context, browserName }) => {
      await start({ page, context, browserName }, { offline: mode === 'offline' })
      await browseSets(page)
      await openLanguage(page, 'ja')

      // From a series' sets: the switch lands on the other language's series, not on this series.
      await seriesTile(page, landmarks.ja.series).click()
      await expect(page.getByTestId('sets-grid')).toBeVisible({ timeout: 20000 })
      await expectOnlyLanguage(page, 'ja')
      await switchLanguage(page, 'English')
      await expect(seriesGrid(page)).toBeVisible({ timeout: 20000 })
      await expect(page).toHaveURL(/\/sets\/language\/en$/)
      await seriesTile(page, landmarks.en.series).click()
      await expect(page.getByTestId('sets-grid')).toBeVisible({ timeout: 20000 })
      await expectOnlyLanguage(page, 'en')

      // The switch replaced the Japanese series page, so Back walks English, then the Japanese list, then out.
      await back(page)
      await expect(seriesGrid(page)).toBeVisible({ timeout: 10000 })
      await expect.poll(() => path(page)).toBe('/sets/language/en')
      await back(page)
      await expect(seriesGrid(page)).toBeVisible({ timeout: 10000 })
      await expect.poll(() => path(page)).toBe('/sets/language/ja')
      await back(page)
      await expect(page.getByTestId('sets-languages')).toBeVisible({ timeout: 10000 })
    })
  })
}

test.describe('language-first sets, settings and servers', () => {
  test.setTimeout(240000)

  test('"Sets open in" skips the language list, and Back goes to Search', async ({ page, context, browserName }) => {
    await start({ page, context, browserName }, { waitForDb: false })
    // Set it the way a person does: Settings > Appearance.
    await page.goto('/settings/appearance')
    const row = page.locator('select').filter({ has: page.locator('option', { hasText: 'Choose each time' }) })
    await expect(row).toBeVisible({ timeout: 20000 })
    await expect(row).toHaveValue('')
    await row.selectOption('ja')
    await expect(row).toHaveValue('ja')

    await page.getByTestId('tab-bar').getByRole('link', { name: 'Search' }).click()
    await browseSets(page)
    await expect(seriesGrid(page).getByRole('link').first()).toBeVisible({ timeout: 40000 })
    await expect(page).toHaveURL(/\/sets\/language\/ja$/)
    await expect(page.getByTestId('sets-languages')).toHaveCount(0)

    // The language is still one tap away.
    await switchLanguage(page, 'English')
    await expect(page).toHaveURL(/\/sets\/language\/en$/)
    await switchLanguage(page, 'Japanese')
    await expect(page).toHaveURL(/\/sets\/language\/ja$/)

    // Back leaves Sets: the language list was replaced, not stacked.
    await back(page)
    await expect(page.getByTestId('search-browse')).toBeVisible({ timeout: 10000 })
  })

  test('offline with no saved language list, the downloaded languages are offered', async ({ page, context, browserName }) => {
    await start({ page, context, browserName }, { offline: true, hideLanguages: true })
    await browseSets(page)
    await expect(page.getByTestId('sets-languages')).toBeVisible({ timeout: 40000 })
    await expect(page.getByTestId('sets-language-en')).toBeVisible()
    await expect(page.getByTestId('sets-language-ja')).toBeVisible()
    await openLanguage(page, 'ja')
  })

  test('a default language that is no longer visible falls back to the language list', async ({ page, context, browserName }) => {
    await start({ page, context, browserName }, { waitForDb: false, settings: { sets_default_language: 'ko' } })
    await browseSets(page)
    await expect(page.getByTestId('sets-languages')).toBeVisible({ timeout: 40000 })
  })

  test('a server with one language has no language step and no switch', async ({ page, context, browserName }) => {
    await start({ page, context, browserName }, { languages: ['en'], waitForDb: false })
    await browseSets(page)
    await expect(seriesGrid(page).getByRole('link').first()).toBeVisible({ timeout: 40000 })
    await expect(page).toHaveURL(/\/sets\/language\/en$/)
    await expect(page.getByTestId('sets-languages')).toHaveCount(0)
    await expect(page.getByTestId('sets-language-switch')).toHaveCount(0)

    await seriesTile(page, landmarks.en.series).click()
    await expect(page.getByTestId('sets-grid')).toBeVisible({ timeout: 20000 })
    await expect(page.getByTestId('sets-language-switch')).toHaveCount(0)
    await back(page)
    await back(page)
    await expect(page.getByTestId('search-browse')).toBeVisible({ timeout: 10000 })
  })

  test('old links land in their language', async ({ page, context, browserName }) => {
    await start({ page, context, browserName }, { waitForDb: false })
    await page.goto('/sets?lang=ja')
    await expect(seriesGrid(page).getByRole('link').first()).toBeVisible({ timeout: 40000 })
    await expect(page).toHaveURL(/\/sets\/language\/ja$/)
    await page.goto('/sets/series/sv~ja')
    await expect(page).toHaveURL(/\/sets\/language\/ja\/series\/sv$/, { timeout: 20000 })
  })

  test('forward and back five times never stalls the page', async ({ page, context, browserName }) => {
    await start({ page, context, browserName })
    await browseSets(page)
    await expect(page.getByTestId('sets-languages')).toBeVisible({ timeout: 40000 })
    const landmark = landmarks.ja
    const stalls = []
    const backs = []
    for (let round = 1; round <= 5; round += 1) {
      await resetStall(page)
      await page.getByTestId('sets-language-ja').click()
      await expect(seriesGrid(page).getByRole('link').first()).toBeVisible({ timeout: 20000 })
      await seriesTile(page, landmark.series).click()
      await expect(page.getByTestId('sets-grid')).toBeVisible({ timeout: 20000 })
      await page.getByRole('button', { name: landmark.setName, exact: true }).click()
      await setPageCards(page)
      backs.push(await tapBack(page, 'sets-grid'))
      await expect(page.getByTestId('sets-grid')).toBeVisible({ timeout: 5000 })
      await back(page)
      await expect(seriesGrid(page)).toBeVisible({ timeout: 5000 })
      backs.push(await tapBack(page, 'sets-languages'))
      await expect(page.getByTestId('sets-languages')).toBeVisible({ timeout: 5000 })
      stalls.push(await readStall(page))
    }
    console.log(`[${browserName}] stalls (ms): ${JSON.stringify(stalls)}, backs (ms): ${JSON.stringify(backs)}`)
    test.info().annotations.push({ type: 'timings', description: JSON.stringify({ stalls, backs }) })
    for (const stall of stalls) expect(stall, 'main thread stall').toBeLessThan(600)
    for (const time of backs) expect(time, 'Back to painted').toBeLessThan(1500)
  })
})
