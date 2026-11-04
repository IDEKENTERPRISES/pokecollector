import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// Scan review: tap your photo or the selected match to zoom it full screen, flip between the two, close.
// Every API is mocked. Runs in the Chromium "mobile" project and in "webkit-iphone" at 390 x 844; the zoomed
// states are also written to test-results/review-zoom/<project>/ (not committed).

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', '..', 'test-results', 'review-zoom')

const USER = { id: 1, username: 'ash', role: 'admin', is_active: true, must_change_password: false }

// A 120 x 168 card-shaped picture, so zoom and pan have something real to work on.
const svg = label => `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="504" viewBox="0 0 360 504"><rect width="360" height="504" fill="#1d4ed8"/><rect x="20" y="20" width="320" height="464" rx="18" fill="#f8fafc"/><text x="40" y="70" font-size="34" font-family="sans-serif" font-weight="700">${label}</text><text x="40" y="470" font-size="26" font-family="sans-serif">OBF 125/197</text></svg>`

const match = (id, name, number) => ({
  id: `${id}_en`, tcg_card_id: id, name, number, set: 'Obsidian Flames', set_abbreviation: 'OBF', rarity: 'Double Rare', lang: 'en',
  image: `https://assets.tcgdex.net/en/sv/${id}/${number}/low.webp`,
  image_hd: `https://assets.tcgdex.net/en/sv/${id}/${number}/high.webp`,
})

async function install(page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(user => {
    localStorage.setItem('token', 'review-zoom-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
    localStorage.setItem('pc.splash.enabled', '0')
  }, USER)
  const items = [{
    id: 31, job_id: 1, position: 0, status: 'done', resolved: false, has_image: true, recognized: { language: 'en' },
    matches: [match('sv3-125', 'Charizard ex', '125'), match('sv3-126', 'Charmeleon', '126')], error: null, retry_reason: null,
  }]
  await page.route('https://assets.tcgdex.net/**', route => route.fulfill({ body: svg('Match: Charizard ex'), contentType: 'image/svg+xml' }))
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: USER })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR', exchange_rate: 1, price_primary: 'trend', price_display: '["trend"]' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: { languages: [{ code: 'en', name: 'English' }] } })
    if (path === '/api/progress/unlocks/unseen') return route.fulfill({ json: { unlocks: [] } })
    if (path === '/api/progress/recap/weekly') return route.fulfill({ json: { show: false, has_activity: false } })
    if (path === '/api/cards/recognize/queue') {
      return route.fulfill({ json: { total: 1, offset: 0, counts: { ready: 1, failed: 0, processing: 0, waiting: 0 }, items } })
    }
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (/\/items\/\d+\/image$/.test(path)) return route.fulfill({ body: svg('Your photo'), contentType: 'image/svg+xml' })
    if (/\/candidates\/\d+\/image$/.test(path)) return route.fulfill({ body: svg('Match: Charizard ex'), contentType: 'image/svg+xml' })
    return route.fulfill({ json: {} })
  })
}

async function capture(page, testInfo, name) {
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForTimeout(500)
  const dir = join(OUT, testInfo.project.name)
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled' })
}

test.use({ viewport: { width: 390, height: 844 } })
test.beforeEach(({ browserName }, testInfo) => {
  void browserName
  test.skip(testInfo.project.name === 'desktop', 'The review is a phone screen.')
})

const viewer = page => page.getByTestId('scan-zoom-viewer')

async function openFlow(page) {
  await install(page)
  await page.goto('/scans')
  await page.getByTestId('scan-review-all').click()
  await expect(page.getByTestId('scan-flow-card')).toBeVisible()
}

test('tap your photo to zoom it, double-tap zooms in, the close button closes', async ({ page }, testInfo) => {
  await openFlow(page)
  await expect(page.getByTestId('scan-flow-photo')).toBeEnabled()
  await page.getByTestId('scan-flow-photo').click()
  await expect(viewer(page)).toBeVisible()
  await expect(page.getByTestId('scan-zoom-caption')).toHaveText('Your photo')
  await expect(page.getByTestId('scan-zoom-image')).toHaveAttribute('data-scale', '1.00')
  // Opaque: the page behind must not show through.
  expect(await viewer(page).evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(0, 0, 0)')
  const closeBox = await page.getByTestId('scan-zoom-close').boundingBox()
  expect(closeBox.width).toBeGreaterThanOrEqual(44)
  expect(closeBox.height).toBeGreaterThanOrEqual(44)
  await capture(page, testInfo, '01-your-photo-zoomed')

  const image = await page.getByTestId('scan-zoom-image').boundingBox()
  const x = image.x + image.width / 2
  const y = image.y + image.height / 3
  await page.mouse.click(x, y)
  await page.mouse.click(x, y)
  await expect(page.getByTestId('scan-zoom-image')).not.toHaveAttribute('data-scale', '1.00')
  await capture(page, testInfo, '02-your-photo-double-tap-zoomed-in')
  await page.mouse.click(x, y)
  await page.mouse.click(x, y)
  await expect(page.getByTestId('scan-zoom-image')).toHaveAttribute('data-scale', '1.00')

  await page.getByTestId('scan-zoom-close').click()
  await expect(viewer(page)).toHaveCount(0)
  await expect(page.getByTestId('scan-flow-card')).toBeVisible()
})

test('tap the selected match to zoom it, flip to your photo and back, tap the background to close', async ({ page }, testInfo) => {
  await openFlow(page)
  await expect(page.getByTestId('scan-flow-best-image')).toHaveAccessibleName(/Selected match: Charizard ex, OBF 125/)
  await page.getByTestId('scan-flow-best-image').click()
  await expect(viewer(page)).toBeVisible()
  await expect(page.getByTestId('scan-zoom-caption')).toContainText('Charizard ex')
  await expect(page.getByTestId('scan-zoom-show-match')).toHaveAttribute('aria-pressed', 'true')
  await capture(page, testInfo, '03-selected-match-zoomed')

  await page.getByTestId('scan-zoom-show-photo').click()
  await expect(page.getByTestId('scan-zoom-caption')).toHaveText('Your photo')
  await page.getByTestId('scan-zoom-show-match').click()
  await expect(page.getByTestId('scan-zoom-caption')).toContainText('Charizard ex')

  // A tap on the empty background (the 8 px margin around the picture) closes.
  const shown = await page.getByTestId('scan-zoom-image').boundingBox()
  await page.mouse.click(4, shown.y - 4)
  await expect(viewer(page)).toHaveCount(0)
})

test('a swipe down closes the viewer', async ({ page }) => {
  await openFlow(page)
  await page.getByTestId('scan-flow-photo').click()
  await expect(viewer(page)).toBeVisible()
  const image = await page.getByTestId('scan-zoom-image').boundingBox()
  const x = image.x + image.width / 2
  await page.mouse.move(x, image.y + 60)
  await page.mouse.down()
  await page.mouse.move(x, image.y + 140, { steps: 4 })
  await page.mouse.move(x, image.y + 260, { steps: 4 })
  await page.mouse.up()
  await expect(viewer(page)).toHaveCount(0)
})
