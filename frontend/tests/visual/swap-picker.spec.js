import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// The swap picker (docs/SOCIAL_DESIGN.md §5.4) after the owner's r9-02 change: both steps list every card, with the
// Collection filters and a Spares choice. Every API is mocked. Runs in the Chromium "mobile" project and in
// "webkit-iphone" at 390 x 844; each frame is also written to test-results/swap-picker/<project>/ (not committed).

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', '..', 'test-results', 'swap-picker')

const ASH = { id: 1, username: 'Ash', role: 'admin', is_active: true, must_change_password: false, avatar_id: null }
const MISTY = { id: 2, username: 'Misty', avatar_id: null }

const RARITIES = ['Common', 'Uncommon', 'Rare Holo', 'Illustration Rare']
const TYPES = ['Fire', 'Water', 'Grass', 'Lightning']
const SETS = [['sv1_en', 'sv1', 'Scarlet & Violet', 'SVI'], ['sv3_en', 'sv3', 'Obsidian Flames', 'OBF']]

/** A candidate with a bit of variety: n = 1 is common, 2 uncommon, ... so filters have something to do. */
const candidate = (n, base, extra = {}) => {
  const [setKey, setId, setName, code] = SETS[n % 2]
  const quantity = n % 3 === 0 ? 3 : n % 4 === 0 ? 2 : 1
  const spare = n % 3 === 0 ? 2 : 0
  return {
    collection_item_id: base + n,
    card_id: `${setId}-${n}_en`,
    card_name: `${['Pikachu', 'Eevee', 'Charmander', 'Squirtle', 'Bulbasaur', 'Mew'][n % 6]} ${n}`,
    set_id: setId,
    set_key: setKey,
    set_name: setName,
    set_code: code,
    card_number: String(n),
    variant: n % 5 === 0 ? 'Holo' : 'Normal',
    condition: n % 7 === 0 ? 'LP' : 'NM',
    lang: 'en',
    images_small: null,
    types: [TYPES[n % 4]],
    rarity: RARITIES[n % 4],
    supertype: n % 8 === 0 ? 'Trainer' : 'Pokemon',
    subtypes: n % 8 === 0 ? ['Supporter'] : ['Basic'],
    trainer_type: n % 8 === 0 ? 'Supporter' : null,
    energy_type: null,
    stage: n % 8 === 0 ? null : 'Basic',
    standard_legal: n % 2 === 0,
    printing_details: n % 9 === 0 ? ['Stamped'] : [],
    quantity,
    offerable: quantity,
    spare,
    on_wishlist: false,
    value: n % 5 === 0 ? 20 + n : n / 10,
    ...extra,
  }
}
const list = (count, base, extra) => Array.from({ length: count }, (_, index) => candidate(index + 1, base, extra?.(index + 1)))
const payload = (items, wishlist = 0) => ({
  items,
  counts: {
    all: items.length,
    spares: items.filter(item => item.spare > 0).length,
    wishlist: items.filter(item => item.on_wishlist).length || wishlist,
  },
  wishlist_visible: true,
})

const YOURS = list(24, 1000)
const THEIRS = list(24, 2000)
const BIG = list(5000, 100000)

const SPARES = THEIRS.filter(item => item.spare > 0).length // n % 3 === 0 -> 8 of 24

async function install(page, { theirs = THEIRS } = {}) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript((account) => {
    localStorage.setItem('token', 'swap-picker-token')
    localStorage.setItem('user', JSON.stringify(account))
    localStorage.setItem('app_language', 'en')
    localStorage.setItem('pc.splash.enabled', '0')
  }, ASH)
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path.startsWith('/api/images/') || path.startsWith('/api/pokedex/images/')) return route.fulfill({ status: 404, body: '' })
    if (path === '/api/swaps' || path === '/api/swaps/') return route.fulfill({ json: { incoming: [], outgoing: [], history: [], waiting_count: 0 } })
    if (path === '/api/swaps/waiting') return route.fulfill({ json: { count: 0 } })
    if (path === '/api/swaps/candidates') {
      return route.fulfill({ json: payload(url.searchParams.get('side') === 'give' ? YOURS : theirs) })
    }
    if (path === '/api/social/leaderboard') {
      return route.fulfill({ json: [ASH, MISTY].map(trainer => ({ user_id: trainer.id, username: trainer.username, role: 'user', avatar_id: null, total_value: 100, total_cards: 10, unique_cards: 9, sets_completed: 1, pnl: 1, most_valuable_card: null })) })
    }
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/progress/unlocks/unseen') return route.fulfill({ json: { unlocks: [] } })
    if (path === '/api/progress/recap/weekly') return route.fulfill({ json: { show: false, has_activity: false } })
    const responses = {
      '/api/auth/mode': { multi_user: true },
      '/api/auth/me': ASH,
      '/api/settings/': { language: 'en', price_primary: 'trend', currency: 'GBP', tcgdex_sync_languages: 'en', social_features_enabled: 'true' },
      '/api/settings/tcgdex-filter-languages': ['en'],
      '/api/profile/': { feature_enabled: false, is_profile_public: false },
      '/api/trades': [],
      '/api/trades/': [],
      '/api/collection/': [],
      '/api/cards/custom': [],
    }
    return route.fulfill({ json: responses[path] ?? {} })
  })
}

async function capture(page, testInfo, name) {
  await page.evaluate(async () => { await document.fonts.ready })
  await page.waitForTimeout(700)
  const dir = join(OUT, testInfo.project.name)
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled' })
}

test.use({ viewport: { width: 390, height: 844 } })
test.beforeEach(({ browserName }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'The picker is a phone sheet.')
  void browserName
})

const tiles = page => page.locator('ul li button[aria-pressed]')
const showing = page => page.getByRole('status').filter({ hasText: 'Showing' })

async function openComposer(page) {
  await page.goto('/trades/offers')
  await page.getByRole('button', { name: 'New offer' }).click()
  await page.getByRole('button', { name: 'Misty' }).click()
  const sheet = page.getByRole('dialog', { name: 'Swap with Misty' })
  await expect(sheet).toBeVisible()
  return sheet
}

async function openStep(page, sheet, step) {
  if (step === 'yours') {
    await sheet.getByRole('button', { name: 'Add from your cards' }).click()
    await expect(page.getByRole('dialog', { name: 'Your cards' })).toBeVisible()
  } else {
    await sheet.getByRole('button', { name: "Add from Misty's cards" }).click()
    await expect(page.getByRole('dialog', { name: "Misty's cards" })).toBeVisible()
  }
}

const filtersDialog = page => page.getByRole('dialog', { name: 'Filters' })

for (const step of ['yours', 'theirs']) {
  test.describe(`${step} step`, () => {
    test('lists every card, not only spares', async ({ page }, testInfo) => {
      await install(page)
      const sheet = await openComposer(page)
      await openStep(page, sheet, step)
      await expect(showing(page)).toHaveText('Showing 24 of 24')
      await expect(tiles(page)).toHaveCount(24)
      // the radio labels carry the counts; All is selected without a wishlist
      await expect(page.getByRole('radio', { name: 'All · 24' })).toBeChecked()
      await expect(page.getByRole('radio', { name: `Spares · ${SPARES}` })).toBeVisible()
      await capture(page, testInfo, `${step}-1-filters-closed`)
    })

    test('the filters narrow the list and Clear all resets it', async ({ page }, testInfo) => {
      await install(page)
      const sheet = await openComposer(page)
      await openStep(page, sheet, step)
      const filterButton = page.getByRole('button', { name: 'Filter', exact: true })
      expect((await filterButton.boundingBox()).height).toBeGreaterThanOrEqual(36)

      await filterButton.click()
      const panel = filtersDialog(page)
      await expect(panel).toBeVisible()
      await panel.getByLabel('Rarity').selectOption('Rare Holo')
      await panel.getByLabel('Element').selectOption('Grass')
      await capture(page, testInfo, `${step}-2-filters-open`)
      await panel.getByRole('button', { name: 'Advanced filters' }).click()
      await panel.getByLabel('Duplicates only').check()
      await panel.getByRole('button', { name: 'Done' }).click()

      // 24 candidates: n % 4 === 2 is Rare Holo, n % 4 === 2 is Grass (TYPES[2]); duplicates need quantity > 1
      const expected = THEIRS.filter(item => item.rarity === 'Rare Holo' && item.types[0] === 'Grass' && item.quantity > 1).length
      await expect(showing(page)).toHaveText(`Showing ${expected} of 24`)
      await expect(tiles(page)).toHaveCount(expected)
      await expect(filterButton).toContainText('3')
      await capture(page, testInfo, `${step}-3-filtered`)

      await page.getByRole('button', { name: 'Clear all' }).click()
      await expect(showing(page)).toHaveText('Showing 24 of 24')
      await expect(tiles(page)).toHaveCount(24)
      await expect(page.getByRole('button', { name: 'Clear all' })).toHaveCount(0)
    })

    test('the sheet Clear button resets the filters', async ({ page }) => {
      await install(page)
      const sheet = await openComposer(page)
      await openStep(page, sheet, step)
      await page.getByRole('button', { name: 'Filter', exact: true }).click()
      const panel = filtersDialog(page)
      await panel.getByLabel('Condition').selectOption('LP')
      await expect(showing(page)).toHaveText('Showing 3 of 24')
      await panel.getByRole('button', { name: 'Clear', exact: true }).click()
      await expect(showing(page)).toHaveText('Showing 24 of 24')
    })

    test('Spares keeps copies with a spare, and filters combine with it', async ({ page }) => {
      await install(page)
      const sheet = await openComposer(page)
      await openStep(page, sheet, step)
      await page.getByRole('radio', { name: `Spares · ${SPARES}` }).click()
      await expect(tiles(page)).toHaveCount(SPARES)
      await page.getByRole('button', { name: 'Filter', exact: true }).click()
      await filtersDialog(page).getByLabel('Condition').selectOption('LP')
      await filtersDialog(page).getByRole('button', { name: 'Done' }).click()
      const lp = THEIRS.filter(item => item.spare > 0 && item.condition === 'LP').length
      await expect(tiles(page)).toHaveCount(lp)
      await page.getByRole('button', { name: 'Clear all' }).click()
      await expect(page.getByRole('radio', { name: 'All · 24' })).toBeChecked()
      await expect(tiles(page)).toHaveCount(24)
    })

    test('search still works with the filters', async ({ page }) => {
      await install(page)
      const sheet = await openComposer(page)
      await openStep(page, sheet, step)
      await page.getByRole('searchbox').fill('Mew')
      await expect(tiles(page)).toHaveCount(THEIRS.filter(item => item.card_name.startsWith('Mew')).length)
    })
  })
}

test('picking a partner card that is their only copy works', async ({ page }) => {
  await install(page)
  const sheet = await openComposer(page)
  await openStep(page, sheet, 'theirs')
  const single = THEIRS.find(item => item.quantity === 1)
  await page.getByRole('button', { name: new RegExp(`^${single.card_name}, `) }).click()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(sheet.getByRole('button', { name: `Remove ${single.card_name}` })).toBeVisible()
})

test('a partner with thousands of cards renders a page at a time', async ({ page }, testInfo) => {
  await install(page, { theirs: BIG })
  const sheet = await openComposer(page)
  await openStep(page, sheet, 'theirs')
  await expect(showing(page)).toHaveText('Showing 5000 of 5000')
  const first = await tiles(page).count()
  expect(first).toBeLessThan(400)
  // typing in search and filtering stay quick on the full list
  const started = Date.now()
  await page.getByRole('searchbox').fill('Mew 4')
  await expect(showing(page)).not.toHaveText('Showing 5000 of 5000')
  expect(Date.now() - started).toBeLessThan(testInfo.project.name === 'mobile' ? 2000 : 4000)
  await page.getByRole('searchbox').fill('')
  await expect(showing(page)).toHaveText('Showing 5000 of 5000')
  // scrolling to the end of the page loads the next one
  await tiles(page).last().scrollIntoViewIfNeeded()
  await expect.poll(() => tiles(page).count()).toBeGreaterThan(first)
})
