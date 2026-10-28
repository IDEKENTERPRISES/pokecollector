import { expect, test } from '@playwright/test'

// P2: the set page's Book view. A 260-card set (29 pages of 9), about a third owned, in a mocked API:
// the Grid | Book switch (remembered), page turns by buttons and by swipe, Go to page, ghost pockets for
// missing cards, the filters, Split variants, and opening a card from a pocket. Also records how long
// the first page and a page turn take (printed; the CPU is throttled where the browser allows it).

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const HEALTH_OK = { status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'] }
const TOTAL = 260
const owned = index => index % 3 === 0

const cards = Array.from({ length: TOTAL }, (_, index) => {
  const number = String(index + 1)
  const isOwned = owned(index)
  return {
    id: `bk-${number}_en`,
    tcg_card_id: `bk-${number}`,
    name: `Bookmon ${number}`,
    number,
    rarity: index % 5 === 0 ? 'Rare' : 'Common',
    supertype: 'Pokémon',
    types: ['Lightning'],
    images_small: null,
    lang: 'en',
    variants_normal: true,
    variants_reverse: index % 4 === 0,
    owned: isOwned,
    owned_quantity: isOwned ? 1 : 0,
    owned_variants: isOwned ? [{ variant: 'Normal', quantity: 1 }] : [],
    owned_items: [],
  }
})
// The server sends the checklist in an arbitrary order; the book must still be in number order.
const shuffled = [...cards].reverse()
const ownedCount = cards.filter(card => card.owned).length
const CHECKLIST = {
  set: { id: 'bk_en', name: 'Book Set', series: 'Fixture Series', lang: 'en', total: TOTAL },
  cards: shuffled,
  owned_count: ownedCount,
  total_count: TOTAL,
  progress: Math.round((ownedCount / TOTAL) * 100),
}

async function mockApi(context) {
  await context.route(url => url.pathname.startsWith('/api/'), route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: ada })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: ['en'] })
    if (path === '/api/offline/carddb/manifest') return route.fulfill({ json: { enabled: false, format: 1, languages: {} } })
    if (path === '/api/sets/bk_en/checklist') return route.fulfill({ json: CHECKLIST })
    if (path.startsWith('/api/images/') || path.startsWith('/api/pokedex/')) return route.fulfill({ status: 404, json: {} })
    return route.fulfill({ json: [] })
  })
}

async function openSet(page, context, { view = 'book', width = 390 } = {}) {
  await mockApi(context)
  await page.setViewportSize({ width, height: 844 })
  await page.addInitScript(([user, mode]) => {
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('user', JSON.stringify(user))
    if (!sessionStorage.getItem('pc-book-seeded')) {
      sessionStorage.setItem('pc-book-seeded', '1')
      if (mode) localStorage.setItem('pc-book-view:set', mode)
    }
  }, [ada, view])
  try {
    await page.goto('/sets/bk_en')
  } catch (error) {
    if (!/interrupted/i.test(String(error))) throw error
    await page.goto('/sets/bk_en')
  }
}

const currentPage = page => page.getByTestId('book-current').locator('.book-page')
const pageButton = page => page.getByTestId('book-page-button')

test.describe('set page book view', () => {
  test.setTimeout(120000)

  test('switches between Grid and Book and remembers the choice on the device', async ({ page, context }) => {
    await openSet(page, context, { view: 'grid' })
    await expect(page.getByRole('button', { name: 'Bookmon 3', exact: true }).first()).toBeVisible({ timeout: 20000 })
    await expect(page.getByTestId('book-view')).toHaveCount(0)

    await page.getByRole('button', { name: 'Book view' }).click()
    await expect(page.getByTestId('book-view')).toBeVisible()
    await expect(pageButton(page)).toHaveText('Page 1 of 29')
    expect(await page.evaluate(() => localStorage.getItem('pc-book-view:set'))).toBe('book')

    await page.reload()
    await expect(page.getByTestId('book-view')).toBeVisible({ timeout: 20000 })
    await page.getByRole('button', { name: 'Grid view' }).click()
    await expect(page.getByTestId('book-view')).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('pc-book-view:set'))).toBe('grid')
  })

  test('opens in collector-number order with ghost pockets, and turns pages by button, swipe and Go to page', async ({ page, context, browserName }) => {
    if (browserName === 'chromium') {
      // Only Chromium can slow the CPU down; WebKit runs unthrottled.
      const cdp = await context.newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    }
    const started = Date.now()
    await openSet(page, context)
    await expect(currentPage(page)).toBeVisible({ timeout: 20000 })
    const firstPageMs = Date.now() - started

    // 9 pockets, numbers 1-9 in order; every third card is owned, so 1 (index 0) is owned and 2, 3 are ghosts.
    await expect(currentPage(page).getByTestId('book-pocket')).toHaveCount(3)
    await expect(currentPage(page).getByTestId('book-ghost')).toHaveCount(6)
    await expect(currentPage(page).getByTestId('book-ghost').first()).toContainText('2')
    await expect(currentPage(page).getByTestId('book-ghost').first()).toContainText('Bookmon 2')
    await expect(currentPage(page).getByRole('button', { name: 'Bookmon 1', exact: true })).toBeVisible()

    // Only the current page and its neighbour are in the DOM.
    expect(await page.locator('.book-page').count()).toBeLessThanOrEqual(2)

    // Next / previous buttons.
    await page.getByRole('button', { name: 'Previous page' }).isDisabled()
    // In-page: from the tap to the next frame after the new page is committed.
    const turnMs = Math.round(await page.evaluate(() => new Promise(resolve => {
      const label = document.querySelector('[data-testid="book-page-button"]')
      const start = performance.now()
      new MutationObserver((_, observer) => {
        observer.disconnect()
        requestAnimationFrame(() => resolve(performance.now() - start))
      }).observe(label, { childList: true, characterData: true, subtree: true })
      document.querySelector('button[aria-label="Next page"]').click()
    })))
    await expect(pageButton(page)).toHaveText('Page 2 of 29')
    await expect(currentPage(page).getByRole('button', { name: 'Bookmon 10', exact: true })).toBeAttached()
    expect(await page.locator('.book-page').count()).toBeLessThanOrEqual(3)

    // Swipe left for the next page, right to go back.
    const box = await page.locator('.book-viewport').boundingBox()
    const y = box.y + 120
    await page.mouse.move(box.x + box.width - 30, y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, y, { steps: 6 })
    await page.mouse.move(box.x + 20, y, { steps: 6 })
    await page.mouse.up()
    await expect(pageButton(page)).toHaveText('Page 3 of 29')
    await page.mouse.move(box.x + 20, y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 30, y, { steps: 12 })
    await page.mouse.up()
    await expect(pageButton(page)).toHaveText('Page 2 of 29')

    // Go to page.
    await pageButton(page).click()
    const sheet = page.getByRole('dialog', { name: 'Go to page' })
    await expect(sheet).toBeVisible()
    await sheet.getByRole('spinbutton').fill('29')
    await sheet.getByRole('button', { name: 'Go' }).click()
    await expect(pageButton(page)).toHaveText('Page 29 of 29')
    // The last page holds cards 253-260 (8) and one empty pocket.
    await expect(currentPage(page).getByRole('button', { name: 'Bookmon 260', exact: true })).toBeAttached()
    await expect(page.getByRole('button', { name: 'Next page' })).toBeDisabled()

    console.log(`BOOK_TIMINGS first_page_ms=${firstPageMs} page_turn_ms=${turnMs}`)
  })

  test('filters apply: Missing shows only ghosts; Split variants gives each variant a pocket; a pocket opens the card sheet', async ({ page, context }) => {
    await openSet(page, context)
    await expect(currentPage(page)).toBeVisible({ timeout: 20000 })

    await page.getByRole('button', { name: 'Filter' }).click()
    await page.getByRole('menuitemradio', { name: /^Missing/ }).click()
    await expect(page.getByTestId('book-view')).toHaveAttribute('data-pages', String(Math.ceil((TOTAL - ownedCount) / 9)))
    await expect(currentPage(page).getByTestId('book-pocket')).toHaveCount(0)
    await expect(currentPage(page).getByTestId('book-ghost')).toHaveCount(9)

    await page.getByRole('button', { name: 'Filter' }).click()
    await page.getByRole('menuitemradio', { name: 'All (260)' }).click()
    const reverseCount = cards.filter((_, index) => index % 4 === 0).length
    await page.getByRole('switch', { name: 'Split variants' }).click()
    await expect(page.getByTestId('book-view')).toHaveAttribute('data-pages', String(Math.ceil((TOTAL + reverseCount) / 9)))

    await page.getByRole('switch', { name: 'Split variants' }).click()
    await currentPage(page).getByRole('button', { name: 'Bookmon 1', exact: true }).dispatchEvent('click')
    await expect(page.getByRole('dialog', { name: 'Bookmon 1' })).toBeVisible({ timeout: 10000 })
  })

  test('dragging a page does not re-render the pockets', async ({ page, context }) => {
    await openSet(page, context)
    await expect(currentPage(page)).toBeVisible({ timeout: 20000 })
    await page.waitForTimeout(500)
    const box = await page.locator('.book-viewport').boundingBox()
    const y = box.y + 120
    const renders = () => page.evaluate(() => window.__bookPocketRenders ?? 0)
    await page.mouse.move(box.x + box.width - 30, y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 60, y, { steps: 2 })
    const before = await renders()
    await page.mouse.move(box.x + 60, y, { steps: 25 })
    expect(await page.getByTestId('book-current').evaluate(node => getComputedStyle(node).transform)).not.toBe('none')
    expect(await renders()).toBe(before)
    await page.mouse.up()
    await expect(pageButton(page)).toHaveText('Page 2 of 29')
  })

  test('shows two-page spreads on a wide screen', async ({ page, context }) => {
    await openSet(page, context, { width: 1280 })
    await expect(page.getByTestId('book-current').locator('.book-page')).toHaveCount(2, { timeout: 20000 })
    await expect(pageButton(page)).toHaveText('Pages 1–2 of 29')
    await page.getByRole('button', { name: 'Next page' }).click()
    await expect(pageButton(page)).toHaveText('Pages 3–4 of 29')
  })

  test('turns instantly under reduced motion', async ({ page, context }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openSet(page, context)
    await expect(currentPage(page)).toBeVisible({ timeout: 20000 })
    await page.getByRole('button', { name: 'Next page' }).click()
    await expect(pageButton(page)).toHaveText('Page 2 of 29')
    await expect(page.locator('.book-unit-turning')).toHaveCount(0)
  })
})
