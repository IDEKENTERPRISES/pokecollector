import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// Scan inbox "Review all": one continuous list and a card-by-card flow (add, pick another, none of these ->
// search, skip, dismiss, resume). Every API is mocked. Runs in the Chromium "mobile" project and in
// "webkit-iphone" at 390 x 844; each frame is also written to test-results/scan-review-flow/<project>/ (not committed).

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', '..', 'test-results', 'scan-review-flow')

const USER = { id: 1, username: 'ash', role: 'admin', is_active: true, must_change_password: false }
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

const match = (id, name, number) => ({
  id: `${id}_en`, tcg_card_id: id, name, number, set: 'Base Set', set_abbreviation: 'BS', rarity: 'Common', lang: 'en',
  image: `https://assets.tcgdex.net/en/base/${id}/${number}/low.webp`,
})

const item = (id, jobId, position, extra = {}) => ({
  id, job_id: jobId, position, status: 'done', resolved: false, has_image: true, recognized: { language: 'en' },
  matches: [], error: null, retry_reason: null, next_attempt_at: null, ...extra,
})

function makeItems() {
  return [
    item(11, 1, 0, { matches: [match('base1-025', 'Pikachu', '25'), match('base1-026', 'Raichu', '26'), match('base1-027', 'Sandshrew', '27')] }),
    item(12, 1, 1, { matches: [match('base1-052', 'Machop', '52')] }),
    item(13, 2, 0, { matches: [match('base1-004', 'Charizard', '4'), match('base1-005', 'Charmeleon', '5')] }),
    item(14, 2, 1, { status: 'failed', error: 'Could not read this photo.' }),
    item(15, 3, 0, { status: 'retrying', retry_reason: 'scanner_unreachable', matches: [] }),
    item(16, 3, 1, { status: 'processing' }),
  ]
}

async function install(page, items, { added = [], resolved = [] } = {}) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(user => {
    localStorage.setItem('token', 'scan-flow-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
    localStorage.setItem('pc.splash.enabled', '0')
  }, USER)
  await page.route('https://assets.tcgdex.net/**', route => route.fulfill({ body: pixel, contentType: 'image/png' }))
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: USER })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR', exchange_rate: 1, price_primary: 'trend', price_display: '["trend"]' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: { languages: [{ code: 'en', name: 'English' }] } })
    if (path === '/api/progress/unlocks/unseen') return route.fulfill({ json: { unlocks: [] } })
    if (path === '/api/progress/recap/weekly') return route.fulfill({ json: { show: false, has_activity: false } })
    if (path === '/api/cards/recognize/queue') {
      const open = items.filter(candidate => !candidate.resolved)
      const counts = { ready: 0, failed: 0, processing: 0, waiting: 0 }
      for (const candidate of open) {
        if (candidate.status === 'done') counts.ready += 1
        else if (candidate.status === 'failed') counts.failed += 1
        else if (candidate.retry_reason === 'scanner_unreachable') counts.waiting += 1
        else counts.processing += 1
      }
      return route.fulfill({ json: { total: open.length, offset: 0, counts, items: open } })
    }
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (/\/recognize\/jobs\/\d+\/items\/\d+\/(image|candidates\/\d+\/image)$/.test(path)) return route.fulfill({ body: pixel, contentType: 'image/png' })
    if (path === '/api/cards/search') {
      return route.fulfill({ json: { data: [{ id: 'base1-007_en', tcg_card_id: 'base1-007', name: 'Squirtle', number: '7', set_name: 'Base Set', lang: 'en', images_small: null }], total_count: 1 } })
    }
    const done = path.match(/\/recognize\/jobs\/(\d+)\/items\/(\d+)\/(resolve-and-add|resolve)$/)
    if (done && request.method() === 'POST') {
      const target = items.find(candidate => candidate.id === Number(done[2]))
      target.resolved = true
      const body = request.postDataJSON()
      if (done[3] === 'resolve') resolved.push(target.id)
      else {
        added.push({ item: target.id, ...body })
        return route.fulfill({ json: { item: target, collection_item: { id: 900 + target.id, card_id: body.card_id, quantity: body.quantity, has_scan_photo: true } } })
      }
      return route.fulfill({ json: target })
    }
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
  test.skip(testInfo.project.name === 'desktop', 'The flow is a phone screen.')
})

const flow = page => page.getByTestId('scan-review-flow')
const progress = page => page.getByTestId('scan-flow-progress')

test('the inbox is one continuous list, however many uploads it came from', async ({ page }, testInfo) => {
  const items = Array.from({ length: 63 }, (_, index) => item(100 + index, 1 + Math.floor(index / 7), index % 7, { matches: [match('base1-025', 'Pikachu', '25')] }))
  await install(page, items)
  await page.goto('/scans')
  await expect(page.getByTestId('scan-queue-total')).toHaveText('63 photos')
  await expect(page.getByTestId('scan-queue-row-status')).toHaveCount(63)
  await expect(page.getByTestId('scan-review-all')).toBeEnabled()
  await capture(page, testInfo, '01-inbox-one-list')
})

test('Review all: add moves straight to the next card, with a progress count and an end screen', async ({ page }, testInfo) => {
  const added = []
  await install(page, makeItems(), { added })
  await page.goto('/scans')
  await expect(page.getByTestId('scan-queue-summary')).toContainText('3 ready')
  await page.getByTestId('scan-review-all').click()
  await expect(flow(page)).toBeVisible()
  await expect(progress(page)).toHaveText('1 of 6')
  await expect(page.getByTestId('scan-flow-chosen')).toContainText('Base Set')
  await expect(page.getByRole('heading', { name: 'Pikachu' })).toBeVisible()
  await capture(page, testInfo, '02-flow-best-match')

  await page.getByTestId('scan-flow-add').click()
  await expect(progress(page)).toHaveText('2 of 6')
  await expect(page.getByRole('heading', { name: 'Machop' })).toBeVisible()
  expect(added[0]).toMatchObject({ item: 11, confirmed_card_id: 'base1-025', card_id: 'base1-025_en', manual_search: false, quantity: 1 })

  await page.getByTestId('scan-flow-add').click()
  await expect(page.getByRole('heading', { name: 'Charizard' })).toBeVisible()
  await page.getByTestId('scan-flow-add').click()
  // Next: the scan with no result (search shown straight away), then the one waiting for the scanner.
  await expect(page.getByTestId('scan-flow-search')).toBeVisible()
  await capture(page, testInfo, '03-flow-no-result-search')
  await page.getByTestId('scan-flow-skip').click()
  await expect(page.getByTestId('scan-flow-search')).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'not reachable' })).toBeVisible()
  await capture(page, testInfo, '04-flow-waiting-for-scanner')
  await page.getByRole('button', { name: 'Wait for the scanner' }).click()
  // Only the skipped ones and one still recognising are left.
  await expect(page.getByTestId('scan-flow-recognising')).toBeVisible()
  await page.getByRole('button', { name: /Review skipped \(2\)/ }).click()
  await expect(page.getByTestId('scan-flow-search')).toBeVisible()
})

test('Pick another changes the card that gets added', async ({ page }) => {
  const added = []
  await install(page, makeItems(), { added })
  await page.goto('/scans')
  await page.getByTestId('scan-review-all').click()
  await page.getByTestId('scan-flow-pick-another').click()
  await expect(page.getByRole('heading', { name: 'Raichu' })).toBeVisible()
  await page.getByRole('button', { name: /Sandshrew/ }).click()
  await expect(page.getByRole('heading', { name: 'Sandshrew' })).toBeVisible()
  await page.getByTestId('scan-flow-add').click()
  await expect.poll(() => added[0]?.confirmed_card_id).toBe('base1-027')
  expect(added[0].manual_search).toBe(false)
})

test('None of these opens the search; the card found is added as a manual pick', async ({ page }, testInfo) => {
  const added = []
  await install(page, makeItems(), { added })
  await page.goto('/scans')
  await page.getByTestId('scan-review-all').click()
  await page.getByTestId('scan-flow-none').click()
  await page.getByPlaceholder('Card name').fill('squirt')
  await page.getByTestId('scan-flow-search-result').first().click()
  await expect(page.getByRole('heading', { name: 'Squirtle' })).toBeVisible()
  await expect(page.getByText('Found by search')).toBeVisible()
  await capture(page, testInfo, '05-flow-picked-from-search')
  await page.getByTestId('scan-flow-add').click()
  await expect.poll(() => added[0]).toMatchObject({ item: 11, confirmed_card_id: 'base1-007', card_id: 'base1-007_en', manual_search: true })
  await expect(progress(page)).toHaveText('2 of 6')
})

test('Dismiss asks first; leaving and coming back resumes at the first scan still waiting', async ({ page }) => {
  const resolved = []
  const items = makeItems()
  await install(page, items, { resolved })
  await page.goto('/scans')
  await page.getByTestId('scan-review-all').click()
  await page.getByTestId('scan-flow-dismiss').click()
  await expect(page.getByRole('dialog', { name: 'Dismiss scan' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  expect(resolved).toEqual([])
  await page.getByTestId('scan-flow-dismiss').click()
  await page.getByRole('dialog', { name: 'Dismiss scan' }).getByRole('button', { name: 'Dismiss scan' }).click()
  await expect(page.getByRole('heading', { name: 'Machop' })).toBeVisible()
  expect(resolved).toEqual([11])

  await page.getByRole('button', { name: 'Close' }).click()
  await expect(flow(page)).toHaveCount(0)
  await page.getByTestId('scan-review-all').click()
  await expect(page.getByRole('heading', { name: 'Machop' })).toBeVisible()
  await expect(progress(page)).toHaveText('1 of 5')
})

test('a scan with no result searches straight away and the pick is added', async ({ page }, testInfo) => {
  const added = []
  const items = makeItems().filter(candidate => candidate.id === 14)
  await install(page, items, { added })
  await page.goto('/scans')
  await page.getByTestId('scan-review-all').click()
  await expect(page.getByText('Could not read this photo.')).toBeVisible()
  await page.getByPlaceholder('Card name').fill('squirt')
  await page.getByTestId('scan-flow-search-result').first().click()
  await page.getByTestId('scan-flow-add').click()
  await expect.poll(() => added[0]).toMatchObject({ item: 14, confirmed_card_id: 'base1-007', manual_search: true })
  await expect(page.getByTestId('scan-flow-done')).toBeVisible()
  await expect(page.getByText('1 added')).toBeVisible()
  await capture(page, testInfo, '06-flow-done')
})

test('a scan the picture was unsure about shows its matches, None of these and Wait for the scanner', async ({ page }, testInfo) => {
  const items = [item(21, 1, 0, {
    recognized: { language: 'en', _picture: { path: 'unsure_inbox' } },
    matches: [match('base1-025', 'Pikachu', '25'), match('base1-026', 'Raichu', '26')],
  })]
  await install(page, items)
  await page.goto('/scans')
  await page.getByTestId('scan-review-all').click()
  await expect(page.getByTestId('scan-picture-unsure')).toBeVisible()
  await expect(page.getByTestId('scan-flow-none')).toBeVisible()
  await expect(page.getByTestId('scan-flow-candidates')).toBeVisible()
  await capture(page, testInfo, '07-flow-picture-unsure')
  await page.getByTestId('scan-flow-wait').click()
  await expect(page.getByTestId('scan-flow-done')).toBeVisible()
})
