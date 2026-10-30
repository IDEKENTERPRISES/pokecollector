import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// Wrapped v2 fidelity (engagement P9c): renders every slide, the thin-data summary and both share
// pictures with the Wave 2b mockups' sample data (Ash, 486 cards, Umbreon ex top pull, …), values on
// and hidden, at 390 × 844. Runs in the Chromium "mobile" project and in "webkit-iphone". Each frame
// is also written to test-results/wrapped-fidelity/<project>/ (not committed) to set beside the
// mockup artboards; the share pictures are written at their real 1080 × 1920 size.

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', '..', 'test-results', 'wrapped-fidelity')

const ASH = { id: 1, username: 'Ash', role: 'admin', is_active: true, must_change_password: false }
const MISTY = { ...ASH, username: 'Misty' }

// Card art stand-ins drawn like the mockups' placeholders (no real card scans in the repo).
const svgCard = ({ face, frame, art, ink, name, code }) => `<svg xmlns="http://www.w3.org/2000/svg" width="490" height="684" viewBox="0 0 245 342">
<defs><linearGradient id="f" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="${face[0]}"/><stop offset="1" stop-color="${face[1]}"/></linearGradient></defs>
<rect width="245" height="342" rx="12" fill="url(#f)"/>
<text x="14" y="26" font-family="Arial" font-weight="800" font-size="16" fill="${ink}">${name}</text>
<text x="231" y="26" text-anchor="end" font-family="Arial" font-weight="700" font-size="11" fill="${ink}">${code}</text>
<rect x="12" y="36" width="221" height="160" rx="6" fill="${art[0]}" stroke="${frame}" stroke-width="3"/>
<circle cx="122" cy="116" r="34" fill="none" stroke="${art[1]}" stroke-width="4"/><circle cx="122" cy="116" r="58" fill="none" stroke="${art[1]}" stroke-opacity="0.5" stroke-width="3"/>
<rect x="14" y="212" width="150" height="9" rx="5" fill="${ink}" fill-opacity="0.3"/><rect x="14" y="230" width="200" height="9" rx="5" fill="${ink}" fill-opacity="0.2"/><rect x="14" y="248" width="176" height="9" rx="5" fill="${ink}" fill-opacity="0.2"/>
</svg>`
const IMAGES = {
  umbreon: svgCard({ face: ['#2A3160', '#0B0E1E'], frame: 'rgba(255,229,110,0.7)', art: ['#1E2450', '#FFCB05'], ink: '#FFFFFF', name: 'Umbreon ex', code: 'PRE 161' }),
  eevee: svgCard({ face: ['#F4EEDC', '#D8CDAE'], frame: '#BBAE8A', art: ['#F1C88A', '#A86B3C'], ink: '#2A2416', name: 'Eevee', code: 'PRE 075' }),
  psyduck: svgCard({ face: ['#F4EEDC', '#D8CDAE'], frame: '#BBAE8A', art: ['#8FC9F0', '#FFE27A'], ink: '#2A2416', name: 'Psyduck', code: 'SSP 047' }),
}

const MONTHS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
// The mockup's curve (W2bValue): its path's y values read back to amounts.
const VALUES = [888, 928, 997, 1118, 1078, 1178, 1310, 1520, 1440, 1400]

export const ASH_WRAPPED = {
  year: 2026,
  history_starts: '2026-03-12',
  partial_history: true,
  totals: { cards: 486, unique_cards: 312, sets_touched: 41, sets_completed: 6 },
  first_card: { item_id: 1, card_id: 'eevee_en', name: 'Eevee', variant: 'Holo', image: '/api/images/card/eevee/small', set_name: 'Prismatic Evolutions', number: '075', acquired_on: '2026-03-12' },
  best_pull: { item_id: 2, card_id: 'umbreon_en', name: 'Umbreon ex', variant: 'Holo', image: '/api/images/card/umbreon/small', price: 182, set_name: 'Prismatic Evolutions', number: '161', acquired_on: '2026-06-14' },
  biggest_month: { month: 6, count: 88 },
  monthly: [0, 0, 82, 43, 59, 88, 41, 30, 52, 61, 22, 8],
  completed_sets: ['Scarlet & Violet 151', 'Paldean Fates', 'Shrouded Fable', 'Stellar Crown', 'Twilight Masquerade', 'Temporal Forces'].map((name, i) => ({ set_id: `s${i}`, name })),
  closest_set: { set_id: 'ssp_en', name: 'Surging Sparks', owned: 171, total: 191, missing: 20 },
  top_pokemon: { dex_id: 133, name: 'Eevee', count: 23 },
  top_type: { type: 'psychic', count: 151 },
  top_illustrator: { name: 'Mitsuhiro Arita', count: 31 },
  value: {
    start: 888, end: 1400, peak: 1520, peak_date: '2026-10-12', start_date: '2026-03-14',
    series: MONTHS.map((month, i) => ({ month, value: VALUES[i] })),
  },
  longest_streak: 41,
  wtp_wins: 112,
  quests_done: 260,
  badges_earned: 18,
  level: 14,
  xp_year: 6840,
  trades: { count: 4, incoming_value: 50, outgoing_value: 40 },
  products: { count: 2, spent: 30 },
}

// W2bThinData: a trainer who started on 3 November with eight cards.
export const MISTY_WRAPPED = {
  year: 2026,
  history_starts: '2026-11-03',
  partial_history: true,
  totals: { cards: 8, unique_cards: 8, sets_touched: 3, sets_completed: 0 },
  first_card: { item_id: 1, card_id: 'psyduck_en', name: 'Psyduck', variant: 'Normal', image: '/api/images/card/psyduck/small', set_name: 'Surging Sparks', number: '047', acquired_on: '2026-11-03' },
  best_pull: { item_id: 1, card_id: 'psyduck_en', name: 'Psyduck', variant: 'Normal', image: '/api/images/card/psyduck/small', price: 4, set_name: 'Surging Sparks', number: '047', acquired_on: '2026-11-03' },
  biggest_month: { month: 11, count: 5 },
  monthly: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 3],
  completed_sets: [],
  closest_set: null,
  top_pokemon: { dex_id: 54, name: 'Psyduck', count: 3 },
  top_type: { type: 'water', count: 5 },
  top_illustrator: null,
  value: null,
  longest_streak: 0,
  wtp_wins: 0,
  quests_done: 0,
  badges_earned: 0,
  level: 0,
  xp_year: 0,
  trades: { count: 0 },
  products: { count: 0 },
}

async function install(page, { wrapped = ASH_WRAPPED, user = ASH, hideValues = false } = {}) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(({ account, hide }) => {
    localStorage.setItem('token', 'wrapped-test-token')
    localStorage.setItem('user', JSON.stringify(account))
    localStorage.setItem('app_language', 'en')
    localStorage.setItem('pc.splash.enabled', '0')
    if (hide) localStorage.setItem('pc.hideValues', '1')
    window.__shared = []
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data) => {
        window.__shared.push((data.files || []).map(file => file.name))
        window.__sharedFile = data.files?.[0] || null
      },
    })
  }, { account: user, hide: hideValues })
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    const card = path.match(/^\/api\/images\/card\/([^/]+)\//)
    if (card) return route.fulfill({ body: IMAGES[card[1]] || IMAGES.eevee, contentType: 'image/svg+xml' })
    if (path.startsWith('/api/pokedex/images/') || path.startsWith('/api/images/')) return route.fulfill({ status: 404, body: '' })
    if (path === '/api/progress/wrapped') return route.fulfill({ json: wrapped })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/progress/unlocks/unseen') return route.fulfill({ json: { unlocks: [] } })
    if (path === '/api/progress/recap/weekly') return route.fulfill({ json: { show: false, has_activity: false } })
    const responses = {
      '/api/auth/mode': { multi_user: false },
      '/api/auth/me': user,
      '/api/settings/': { language: 'en', price_primary: 'trend', currency: 'GBP', tcgdex_sync_languages: 'en' },
      '/api/settings/tcgdex-filter-languages': ['en'],
      '/api/profile/': { feature_enabled: false, is_profile_public: false },
    }
    return route.fulfill({ json: responses[path] ?? {} })
  })
}

const story = page => page.getByTestId('wrapped-story')

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map(img => (img.complete ? null : new Promise(r => { img.onload = img.onerror = r }))))
  })
  await page.waitForTimeout(150)
}

async function goToSlide(page, id) {
  for (let guard = 0; guard < 12; guard += 1) {
    if (await story(page).getAttribute('data-slide') === id) break
    await page.getByRole('button', { name: 'Next slide' }).click()
  }
  await expect(story(page)).toHaveAttribute('data-slide', id)
  await settle(page)
}

async function capture(page, testInfo, name) {
  const dir = join(OUT, testInfo.project.name)
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled' })
  if (process.env.CI) await expect(page).toHaveScreenshot(`wrapped-${name}.png`, { animations: 'disabled' })
}

test.use({ viewport: { width: 390, height: 844 } })
test.beforeEach(({ browserName }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'The fidelity frames are phone-sized.')
  void browserName
})

const SLIDES = ['cover', 'cards', 'first', 'pull', 'favourites', 'sets', 'value', 'streak', 'badges', 'summary']

test('every slide matches its mockup frame, values on', async ({ page }, testInfo) => {
  await install(page)
  await page.goto('/wrapped/2026')
  await expect(story(page)).toHaveAttribute('data-slide', 'cover')
  for (const id of SLIDES) {
    await goToSlide(page, id)
    await capture(page, testInfo, `${SLIDES.indexOf(id) + 1}`.padStart(2, '0') + `-${id}`)
  }
  await expect(page.getByTestId('wrapped-pull-value')).toHaveCount(0)
})

test('hide-values masks the pull, the value slide and the trainer card', async ({ page }, testInfo) => {
  await install(page, { hideValues: true })
  await page.goto('/wrapped/2026')
  await goToSlide(page, 'pull')
  await expect(page.getByTestId('wrapped-pull-value')).toHaveText('£•••')
  await capture(page, testInfo, '04-pull-hidden')
  await goToSlide(page, 'value')
  await expect(page.getByTestId('wrapped-value')).toHaveText('£•••')
  await expect(story(page)).not.toContainText('1.4k')
  await expect(story(page)).not.toContainText('888')
  await capture(page, testInfo, '07-value-hidden')
  await goToSlide(page, 'summary')
  await expect(story(page)).not.toContainText('182')
  await capture(page, testInfo, '10-summary-hidden')
})

test('a new trainer with thin data gets the W2bThinData summary', async ({ page }, testInfo) => {
  await install(page, { wrapped: MISTY_WRAPPED, user: MISTY })
  await page.goto('/wrapped/2026')
  const seen = []
  for (let guard = 0; guard < 12; guard += 1) {
    seen.push(await story(page).getAttribute('data-slide'))
    const next = page.getByRole('button', { name: 'Next slide' })
    if (await next.isDisabled()) break
    await next.click()
  }
  expect(seen).toEqual(['cover', 'cards', 'first', 'pull', 'favourites', 'summary'])
  await settle(page)
  await expect(story(page)).toContainText('006/006')
  await capture(page, testInfo, '11-thin-summary')
})

async function sharePictures(page, testInfo, suffix) {
  await goToSlide(page, 'summary')
  await page.getByTestId('wrapped-share').click()
  await expect(page.getByTestId('wrapped-share-sheet')).toBeVisible()
  for (const kind of ['card', 'poster']) {
    await expect(page.getByTestId(`wrapped-share-${kind}`)).toHaveAttribute('data-ready', 'true', { timeout: 15000 })
  }
  await settle(page)
  await capture(page, testInfo, `12-share-sheet${suffix}`)
  const dir = join(OUT, testInfo.project.name)
  const pictures = {}
  for (const kind of ['card', 'poster']) {
    const dataUrl = await page.getByTestId(`wrapped-preview-${kind}`).evaluate(async img => {
      const blob = await fetch(img.src).then(r => r.blob())
      return new Promise(resolve => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.readAsDataURL(blob)
      })
    })
    pictures[kind] = dataUrl
    writeFileSync(join(dir, `share-${kind}${suffix}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'))
    expect(await page.getByTestId(`wrapped-preview-${kind}`).getAttribute('alt')).not.toMatch(/£\d|182/)
  }
  return pictures
}

async function showPicture(page, testInfo, dataUrl, name) {
  // Shown at one third (360 × 640), as the mockup artboards show the 1080 × 1920 picture.
  await page.setViewportSize({ width: 360, height: 640 })
  await page.setContent(`<body style="margin:0;background:#000"><img src="${dataUrl}" style="display:block;width:360px;height:640px"></body>`)
  await page.waitForFunction(() => document.images[0]?.complete)
  const size = await page.evaluate(() => [document.images[0].naturalWidth, document.images[0].naturalHeight])
  expect(size).toEqual([1080, 1920])
  await capture(page, testInfo, name)
}

test('the share sheet previews both pictures and shares the one tapped', async ({ page }, testInfo) => {
  await install(page)
  await page.goto('/wrapped/2026')
  const pictures = await sharePictures(page, testInfo, '')
  await page.getByTestId('wrapped-share-poster').click()
  await expect.poll(() => page.evaluate(() => window.__shared)).toEqual([['pokecollector-wrapped-2026-stats.png']])
  expect(await page.evaluate(() => localStorage.getItem('pc.wrapped.shareChoice'))).toBe('poster')
  await showPicture(page, testInfo, pictures.card, '13-share-card')
  await showPicture(page, testInfo, pictures.poster, '14-share-poster')
})

async function sharedDataUrl(page) {
  return page.evaluate(() => new Promise(resolve => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.readAsDataURL(window.__sharedFile)
  }))
}

test('the top pull slide shares picture C', async ({ page }, testInfo) => {
  await install(page)
  await page.goto('/wrapped/2026')
  await goToSlide(page, 'pull')
  await expect(page.getByTestId('wrapped-share-pull')).toHaveAttribute('data-ready', 'true', { timeout: 15000 })
  await page.getByTestId('wrapped-share-pull').click()
  await expect.poll(() => page.evaluate(() => window.__shared)).toEqual([['pokecollector-wrapped-2026-top-pull.png']])
  const dataUrl = await sharedDataUrl(page)
  writeFileSync(join(OUT, testInfo.project.name, 'share-pull.png'), Buffer.from(dataUrl.split(',')[1], 'base64'))
  await showPicture(page, testInfo, dataUrl, '17-share-pull')
})

test('the share pictures mask every amount with hide-values', async ({ page }, testInfo) => {
  await install(page, { hideValues: true })
  await page.goto('/wrapped/2026')
  const pictures = await sharePictures(page, testInfo, '-hidden')
  await showPicture(page, testInfo, pictures.card, '13-share-card-hidden')
  await showPicture(page, testInfo, pictures.poster, '14-share-poster-hidden')
})

test('the thin-data share pictures', async ({ page }, testInfo) => {
  await install(page, { wrapped: MISTY_WRAPPED, user: MISTY })
  await page.goto('/wrapped/2026')
  const pictures = await sharePictures(page, testInfo, '-thin')
  await showPicture(page, testInfo, pictures.card, '15-share-card-thin')
  await showPicture(page, testInfo, pictures.poster, '16-share-poster-thin')
})
