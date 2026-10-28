import { expect, test } from '@playwright/test'

// P5: a binder's Book view mirrors the physical binder. A mocked API holds a stateful pocket layout (version
// check included), so the spec covers: a long press lifts a card and a drop on a gap moves it, a drop on a card
// swaps, holding at the page edge turns the page, the Move to… sheet, Close gaps and the pocket size, and that the
// saved order is still there after a reload. It runs on desktop Chromium and on iPhone WebKit (mouse events).

const ada = { id: 1, username: 'ada', role: 'user', avatar_id: null, must_change_password: false }
const HEALTH_OK = { status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'] }
const BINDER_ID = 7

function makeServer() {
  // 12 single-copy entries. Pocket 5 (index 4) is a gap, so the binder has 13 pockets: two pages of 9.
  const entries = Array.from({ length: 12 }, (_, index) => ({
    id: `pk-${index + 1}_en`,
    name: `Pocketmon ${index + 1}`,
    set_id: 'pk',
    number: String(index + 1),
    rarity: 'Common',
    images_small: null,
    images_large: null,
    price_market: 0,
    owned: true,
    quantity: 1,
    owned_quantity: 1,
    collection_quantity: 1,
    required_quantity: 1,
    missing_quantity: 0,
    available_quantity: 0,
    max_assignable_quantity: 1,
    variant: 'Normal',
    condition: 'NM',
    lang: 'en',
    printing_details: [],
    collection_item_id: 100 + index,
    binder_card_id: 500 + index,
    card: { id: `pk-${index + 1}_en`, name: `Pocketmon ${index + 1}`, images_small: null, images_large: null },
  }))
  const state = {
    layout: 9,
    counter: 1,
    puts: 0,
    failNext: 0,
    slots: entries.map((entry, index) => ({ slot_index: index < 4 ? index : index + 1, binder_card_id: entry.binder_card_id, copy_index: 0 })),
  }
  const version = () => `v${state.counter}`
  const payload = () => ({ pocket_layout: state.layout, version: version(), slots: [...state.slots].sort((a, b) => a.slot_index - b.slot_index) })
  return { entries, state, payload, version }
}

async function mockApi(context, server) {
  const { entries, state } = server
  await context.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    if (path === '/api/health') return route.fulfill({ json: HEALTH_OK })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: ada })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/tcgdex-filter-languages') return route.fulfill({ json: ['en'] })
    if (path === '/api/offline/carddb/manifest') return route.fulfill({ json: { enabled: false, format: 1, languages: {} } })
    if (path === `/api/binders/${BINDER_ID}/cards`) {
      return route.fulfill({
        json: {
          binder: { id: BINDER_ID, name: 'Pocket Binder', binder_type: 'collection', pocket_layout: state.layout, color: '#EE1515' },
          cards: entries,
          owned_count: 12,
          total_count: 12,
          total_required_count: 12,
          missing_count: 0,
          unique_count: 12,
          binder_value: 0,
          current_value: 0,
          cost_to_complete: 0,
          unavailable_collection_item_ids: [],
          available_collection_item_quantities: {},
        },
      })
    }
    if (path === `/api/binders/${BINDER_ID}/slots` && method === 'GET') return route.fulfill({ json: server.payload() })
    if (path === `/api/binders/${BINDER_ID}/slots` && method === 'PUT') {
      const body = request.postDataJSON()
      state.puts += 1
      if (state.failNext > 0) {
        state.failNext -= 1
        return route.fulfill({ status: 409, json: { detail: 'The binder layout changed; reload and try again' } })
      }
      if (body.version !== server.version()) return route.fulfill({ status: 409, json: { detail: 'The binder layout changed; reload and try again' } })
      state.slots = body.slots
      state.counter += 1
      return route.fulfill({ json: server.payload() })
    }
    if (path === `/api/binders/${BINDER_ID}/slots/compact` && method === 'POST') {
      state.slots = [...state.slots].sort((a, b) => a.slot_index - b.slot_index).map((slot, index) => ({ ...slot, slot_index: index }))
      state.counter += 1
      return route.fulfill({ json: server.payload() })
    }
    if (path === `/api/binders/${BINDER_ID}` && method === 'PUT') {
      const body = request.postDataJSON()
      if (body.pocket_layout) {
        state.layout = body.pocket_layout
        state.counter += 1
      }
      return route.fulfill({ json: { id: BINDER_ID, name: 'Pocket Binder', binder_type: 'collection', pocket_layout: state.layout, color: '#EE1515', card_count: 12, unique_card_count: 12, is_public: false } })
    }
    if (path.startsWith('/api/images/') || path.startsWith('/api/pokedex/')) return route.fulfill({ status: 404, json: {} })
    return route.fulfill({ json: [] })
  })
}

async function openBinder(page, context, server, { width = 390 } = {}) {
  await mockApi(context, server)
  await page.setViewportSize({ width, height: 844 })
  await page.addInitScript(user => {
    localStorage.setItem('token', 'test-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('pc-book-view:binder', 'book')
  }, ada)
  try {
    await page.goto(`/binders/${BINDER_ID}`)
  } catch (error) {
    if (!/interrupted/i.test(String(error))) throw error
    await page.goto(`/binders/${BINDER_ID}`)
  }
  await expect(page.getByTestId('book-view')).toBeVisible({ timeout: 30000 })
}

const pocket = (page, slotIndex) => page.getByTestId('book-current').locator(`[data-slot-index="${slotIndex}"]`)
const cardIn = (page, slotIndex, name) => pocket(page, slotIndex).getByRole('button', { name, exact: true })
const pageButton = page => page.getByTestId('book-page-button')
const serverIndexOf = (server, entryNumber) => server.state.slots.find(slot => slot.binder_card_id === 499 + entryNumber)?.slot_index

async function center(locator) {
  const box = await locator.boundingBox()
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function liftAndMove(page, from, to, { hold = 480 } = {}) {
  const a = await center(from)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.waitForTimeout(hold)
  const b = await center(to)
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 })
  await page.mouse.move(b.x, b.y, { steps: 4 })
  return b
}

test.describe('binder pockets', () => {
  test.setTimeout(120000)

  test('shows real gaps, and a long press then drop moves a card into the gap and survives a reload', async ({ page, context }) => {
    const server = makeServer()
    await openBinder(page, context, server)
    await expect(pageButton(page)).toHaveText('Page 1 of 2')
    await expect(pocket(page, 4)).toHaveAttribute('data-testid', 'book-gap')
    await expect(cardIn(page, 3, 'Pocketmon 4')).toBeAttached()
    await expect(cardIn(page, 5, 'Pocketmon 5')).toBeAttached()

    await liftAndMove(page, pocket(page, 0), pocket(page, 4))
    // While lifted: a lifted copy follows the pointer and the target pocket is highlighted.
    await expect(page.locator('.book-lifted')).toHaveCount(1)
    await expect(pocket(page, 4)).toHaveAttribute('data-target', '1')
    await page.mouse.up()

    await expect(page.locator('.book-lifted')).toHaveCount(0)
    await expect(cardIn(page, 4, 'Pocketmon 1')).toBeAttached()
    await expect(pocket(page, 0)).toHaveAttribute('data-testid', 'book-gap')
    await expect.poll(() => serverIndexOf(server, 1)).toBe(4)

    await page.reload()
    await expect(page.getByTestId('book-view')).toBeVisible({ timeout: 30000 })
    await expect(cardIn(page, 4, 'Pocketmon 1')).toBeAttached()
    await expect(pocket(page, 0)).toHaveAttribute('data-testid', 'book-gap')
    // The drop did not open the card sheet.
    await expect(page.getByRole('dialog', { name: 'Pocketmon 1' })).toHaveCount(0)
  })

  test('moving a lifted card does not re-render the pockets', async ({ page, context }) => {
    const server = makeServer()
    await openBinder(page, context, server)
    const from = await center(pocket(page, 0))
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.waitForTimeout(480)
    await expect(page.locator('.book-lifted')).toHaveCount(1)
    await page.waitForTimeout(200)
    const renders = () => page.evaluate(() => window.__bookPocketRenders ?? 0)
    const before = await renders()
    const target = await center(pocket(page, 5))
    await page.mouse.move(target.x, target.y, { steps: 20 })
    await page.mouse.move(from.x + 20, from.y + 40, { steps: 20 })
    expect(await renders()).toBe(before)
    await page.mouse.up()
  })

  test('dropping on another card swaps the two', async ({ page, context }) => {
    const server = makeServer()
    await openBinder(page, context, server)
    await liftAndMove(page, pocket(page, 0), pocket(page, 1))
    await page.mouse.up()
    await expect(cardIn(page, 1, 'Pocketmon 1')).toBeAttached()
    await expect(cardIn(page, 0, 'Pocketmon 2')).toBeAttached()
    await expect.poll(() => [serverIndexOf(server, 1), serverIndexOf(server, 2)]).toEqual([1, 0])
  })

  test('a quick drag still swipes the page and does not lift a card', async ({ page, context }) => {
    const server = makeServer()
    await openBinder(page, context, server)
    const box = await page.locator('.book-viewport').boundingBox()
    const y = box.y + 120
    await page.mouse.move(box.x + box.width - 30, y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, y, { steps: 5 })
    await page.mouse.move(box.x + 20, y, { steps: 5 })
    await page.mouse.up()
    await expect(pageButton(page)).toHaveText('Page 2 of 2')
    expect(server.state.puts).toBe(0)
  })

  test('holding a lifted card at the page edge turns the page, and it can be dropped there', async ({ page, context }) => {
    const server = makeServer()
    await openBinder(page, context, server)
    const viewport = await page.locator('.book-viewport').boundingBox()
    const from = await center(pocket(page, 0))
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.waitForTimeout(480)
    await page.mouse.move(viewport.x + viewport.width - 12, from.y, { steps: 6 })
    await expect(pageButton(page)).toHaveText(/Page 2 of 3/, { timeout: 5000 })
    // Page 2 holds indexes 9-12; drop on index 10 (a card): the two swap.
    const target = await center(pocket(page, 10))
    await page.mouse.move(target.x, target.y, { steps: 6 })
    await expect(pocket(page, 10)).toHaveAttribute('data-target', '1')
    await page.mouse.up()
    await expect.poll(() => serverIndexOf(server, 1)).toBe(10)
    await expect(cardIn(page, 10, 'Pocketmon 1')).toBeAttached()
    // The spare page only exists while dragging.
    await expect(pageButton(page)).toHaveText('Page 2 of 2')
  })

  test('Move to… moves a card from the card sheet, and a hold without moving opens the same sheet', async ({ page, context }) => {
    const server = makeServer()
    await openBinder(page, context, server)

    await cardIn(page, 2, 'Pocketmon 3').dispatchEvent('click')
    await page.getByRole('button', { name: 'Move to…' }).click({ timeout: 10000 })

    const sheet = page.getByRole('dialog', { name: 'Move to a pocket' })
    await expect(sheet).toBeVisible()
    await sheet.getByLabel('Page').selectOption({ value: '1' })
    await sheet.getByLabel('Pocket').selectOption({ value: '3' }) // page 2, pocket 4 -> index 12 (Pocketmon 12)
    await expect(sheet.getByTestId('book-move-status')).toHaveText('Swaps places with Pocketmon 12')
    await sheet.getByLabel('Pocket').selectOption({ value: '4' }) // index 13: empty
    await expect(sheet.getByTestId('book-move-status')).toHaveText('Empty pocket')
    await sheet.getByRole('button', { name: 'Move' }).click()
    await expect.poll(() => serverIndexOf(server, 3)).toBe(13)

    // Hold without moving: the lifted card is put down again and the sheet opens.
    const at = await center(pocket(page, 1))
    await page.mouse.move(at.x, at.y)
    await page.mouse.down()
    await page.waitForTimeout(500)
    await page.mouse.up()
    await expect(page.getByRole('dialog', { name: 'Move to a pocket' })).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Move to a pocket' }).getByText('Moving Pocketmon 2')).toBeVisible()
    expect(serverIndexOf(server, 2)).toBe(1)
  })

  test('a failed save puts the card back and says so', async ({ page, context }) => {
    const server = makeServer()
    server.state.failNext = 1
    await openBinder(page, context, server)
    await liftAndMove(page, pocket(page, 0), pocket(page, 4))
    await page.mouse.up()
    await expect(page.getByText('The binder changed somewhere else. Showing the latest layout.').first()).toBeVisible({ timeout: 10000 })
    await expect(cardIn(page, 0, 'Pocketmon 1')).toBeAttached()
    expect(serverIndexOf(server, 1)).toBe(0)
  })

  test('Close gaps (with a confirmation) and Pocket size from the ⋯ menu', async ({ page, context }) => {
    const server = makeServer()
    await openBinder(page, context, server)

    await page.getByRole('button', { name: 'Card list actions' }).click()
    await page.getByRole('menuitem', { name: 'Close gaps' }).click()
    const confirm = page.getByRole('dialog', { name: 'Close the gaps?' })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: 'Close gaps' }).click()
    await expect(pocket(page, 4)).toHaveAttribute('data-testid', 'book-pocket')
    await expect(page.getByTestId('book-view')).toHaveAttribute('data-pages', '2')
    expect(server.state.slots.map(slot => slot.slot_index).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i))

    await page.getByRole('button', { name: 'Card list actions' }).click()
    await page.getByRole('menuitem', { name: 'Pocket size' }).click()
    await page.getByRole('dialog', { name: 'Pockets per page' }).getByRole('button', { name: '4 per page' }).click()
    await expect(page.getByTestId('book-view')).toHaveAttribute('data-layout', '4', { timeout: 10000 })
    await expect(page.getByTestId('book-view')).toHaveAttribute('data-pages', '3')
    expect(server.state.layout).toBe(4)
    // Cards keep their pocket numbers: Pocketmon 5 is still pocket index 4, now on page 2.
    await expect(pageButton(page)).toHaveText('Page 1 of 3')
  })
})
