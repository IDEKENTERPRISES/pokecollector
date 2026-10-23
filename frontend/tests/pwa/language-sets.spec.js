import { expect, test } from '@playwright/test'
import { tcgdexLanguageLabel } from '../../src/utils/tcgdexLanguages.js'
import { JA_PREFIX } from './fixtures/carddb-bilingual.js'
import {
  HEARTBEAT, ada, at, carddbState, data, escape, mockApi, readStall, resetStall, setPageCards, tapBack,
} from './fixtures/language-sets-harness.js'

// F18 (F19: re-pointed at the language-first flow): choosing Japanese on the Sets language list, opening a series and a Japanese set must show
// that Japanese set's own cards (never an English set's), and Back to the series list must stay
// responsive. Driven like a person on an iPhone-sized screen (taps and the Back button, no URL typing)
// with about 30,000 cards and 300 sets in two languages (see fixtures/carddb-bilingual.js): the same
// catalogue ids and series exist in en and ja, some sets are Japanese only, and the last Japanese sets
// have no native cards yet. Run online (a mock server that answers like the real backend) and offline
// (card database downloaded, requests hang, navigator.onLine stays true). Chromium also runs with the
// CPU throttled 4x; the main thread's longest stall is measured in both browsers.

/** The language list is the first screen of Sets: tap a language to open its series. */
async function chooseLanguage(page, code) {
  await page.getByTestId(`sets-language-${code}`).click()
  await expect(page.getByTestId('series-grid').getByRole('link').first()).toBeVisible({ timeout: 40000 })
}

/** The series tile of a set's series (a language shows each series once). */
function seriesTile(page, set) {
  return page.getByTestId('series-grid').getByRole('link', { name: new RegExp(escape(set.series)) }).first()
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
      if (mode === 'offline') {
        // Airplane Mode: requests hang, the device still says it is online. (The language list stays
        // answered: a person who opened Sets before has it saved for offline use.)
        state.offline = true
        expect(await page.evaluate(() => navigator.onLine)).toBe(true)
      }
      await tabBar.getByRole('link', { name: 'Search' }).click()
      await expect(page.getByTestId('search-browse')).toBeVisible({ timeout: 20000 })
      if (mode === 'offline') await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 40000 })
      await page.getByTestId('browse-sets').click()
      await expect(page.getByTestId('sets-languages')).toBeVisible({ timeout: 40000 })
    }

    for (const wanted of ['ja']) {
      test(`${wanted}: a Japanese set shows its own cards and Back to the series stays responsive`, async ({ page, context, browserName }) => {
        await start({ page, context, browserName })
        const timings = {}
        const landmark = data.ja.landmark
        const landmarkSet = data.ja.setList.find(set => set.id === landmark.setId)

        await chooseLanguage(page, wanted)
        await expect(page.getByTestId('series-grid')).toBeVisible()
        await page.waitForTimeout(1500) // a person looks at the list before tapping
        // The same series exists in both languages, but this language lists it once.
        await expect(page.getByTestId('series-grid').getByRole('link', { name: new RegExp(escape(landmark.series)) })).toHaveCount(1)
        await seriesTile(page, landmarkSet).click()
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
      await seriesTile(page, data.ja.setList.find(set => set.id === landmark.setId)).click()
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
        await seriesTile(page, set).click()
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
