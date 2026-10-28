import { expect, test } from '@playwright/test'

// Holo viewer on the owned-card sheet (P3). Runs on desktop and mobile Chromium, and on iPhone
// WebKit through playwright.webkit.config.js.

const USER = { id: 1, username: 'Holo Reviewer', role: 'admin', is_active: true, must_change_password: false }

const makeCard = (id, extra = {}) => ({
  id,
  card_id: id,
  name: 'Holo Test Card',
  number: '012',
  set_id: 'sv05',
  set_name: 'Holo Set',
  set_ref: { id: 'sv05', name: 'Holo Set', abbreviation: 'HLS' },
  rarity: 'Rare Holo',
  supertype: 'Pokemon',
  subtypes: ['Basic'],
  types: ['Lightning'],
  price_market: 5,
  price_trend: 5,
  variants_normal: true,
  variants_reverse: true,
  ...extra,
})

function installFixtures(page, { printingDetails = [], foilPattern = null } = {}) {
  const state = {
    item: {
      id: 1,
      card_id: 'holo-card-1',
      quantity: 1,
      variant: 'Holo',
      printing_details: printingDetails,
      foil_pattern: foilPattern,
      condition: 'NM',
      lang: 'en',
      purchase_price: 2,
      added_at: '2026-07-21T12:00:00',
      card: makeCard('holo-card-1'),
    },
    puts: [],
  }

  return (async () => {
    const cardBack = await (await page.request.get('/cardback.jpg')).body()
    await page.addInitScript((user) => {
      localStorage.setItem('token', 'holo-test-token')
      localStorage.setItem('user', JSON.stringify(user))
      localStorage.setItem('app_language', 'en')
    }, USER)

    await page.route('**/api/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      if (!path.startsWith('/api/')) return route.continue()
      if (path.startsWith('/api/images/card/')) {
        return route.fulfill({ status: 200, contentType: 'image/jpeg', body: cardBack })
      }
      if (path === '/api/collection/1' && request.method() === 'PUT') {
        const body = request.postDataJSON()
        state.puts.push(body)
        state.item = { ...state.item, ...body }
        return route.fulfill({ json: state.item })
      }
      const responses = {
        '/api/auth/mode': { multi_user: true },
        '/api/auth/me': USER,
        '/api/settings/': { language: 'en', price_primary: 'trend', currency: 'EUR', tcgdex_sync_languages: 'en' },
        '/api/settings/tcgdex-filter-languages': ['en'],
        '/api/profile/': { feature_enabled: false, is_profile_public: false },
        '/api/collection/': [state.item],
        '/api/collection/printing-detail-tags': [{ id: 11, name: 'Cosmos', usage_count: 1 }],
        '/api/wishlist/': [],
        '/api/sets/': [],
        '/api/binders/': [],
      }
      return route.fulfill({ json: responses[path] ?? {} })
    })
    return state
  })()
}

async function openSheet(page) {
  await page.goto('/collection')
  await page.getByRole('button', { name: /Holo Test Card/ }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const stage = dialog.getByTestId('holo-stage')
  await expect(stage).toBeVisible()
  return { dialog, stage }
}

// The sheet slides in on phones; wait until the artwork stops moving before using coordinates.
async function settledBox(locator) {
  let previous = null
  for (let i = 0; i < 40; i += 1) {
    const box = await locator.boundingBox()
    if (previous && box && box.x === previous.x && box.y === previous.y) return box
    previous = box
    await locator.page().waitForTimeout(100)
  }
  return previous
}

const cssVar = (locator, name) => locator.evaluate((el, n) => el.style.getPropertyValue(n), name)

test('opens the sheet with the pattern the rules pick', async ({ page }) => {
  await installFixtures(page)
  const { dialog, stage } = await openSheet(page)
  await expect(stage).toHaveAttribute('data-foil', 'holo')
  await expect(stage).toHaveAttribute('data-foil-source', 'rules')
  await expect(dialog.getByTestId('foil-current')).toContainText('Automatic · Holo')
})

test('dragging tilts the card and it settles flat again', async ({ page }) => {
  await installFixtures(page)
  const { stage } = await openSheet(page)
  const box = await settledBox(stage)
  expect(await cssVar(stage, '--rotate-x')).toMatch(/^-?0(\.0+)?deg$/)

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.3, { steps: 12 })
  await expect.poll(async () => parseFloat(await cssVar(stage, '--rotate-x'))).toBeGreaterThan(4)
  await expect.poll(async () => parseFloat(await cssVar(stage, '--rotate-y'))).toBeGreaterThan(2)
  await page.mouse.up()

  await expect.poll(async () => Math.abs(parseFloat(await cssVar(stage, '--rotate-x')))).toBeLessThan(0.1)
})

test('a drag does not open the zoom overlay but a tap does', async ({ page }) => {
  await installFixtures(page)
  const { dialog, stage } = await openSheet(page)
  const box = await settledBox(stage)
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5, { steps: 8 })
  await page.mouse.up()
  await expect(page.getByRole('dialog', { name: /Zoom image/ })).toHaveCount(0)

  await stage.getByRole('button', { name: /Zoom image/ }).click()
  await expect(page.getByRole('dialog', { name: /Zoom image/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
})

test('flips to the card back and returns', async ({ page }) => {
  await installFixtures(page)
  const { dialog, stage } = await openSheet(page)
  await dialog.getByTestId('holo-flip').click()
  await expect(stage).toHaveAttribute('data-flipped', 'true')
  await expect(stage.locator('.holo__back img')).toHaveAttribute('src', '/cardback.jpg')
  await expect(dialog.getByTestId('holo-flip')).toHaveText(/Show front/)
  await dialog.getByTestId('holo-flip').click()
  await expect(stage).toHaveAttribute('data-flipped', 'false')
})

test('the Foil pattern picker saves to the copy and Automatic clears it', async ({ page }) => {
  const state = await installFixtures(page)
  const { dialog, stage } = await openSheet(page)

  await dialog.getByRole('button', { name: /Foil pattern/ }).click()
  await dialog.getByRole('radio', { name: /^Gold$/ }).click()
  await expect(stage).toHaveAttribute('data-foil', 'gold')
  await expect(stage).toHaveAttribute('data-foil-source', 'copy')
  expect(state.puts.at(-1)).toEqual({ foil_pattern: 'gold' })
  await expect(dialog.getByTestId('foil-explanation')).toContainText('Automatic would be Holo')

  await dialog.getByRole('button', { name: /Foil pattern/ }).click()
  await dialog.getByRole('radio', { name: 'Automatic' }).click()
  await expect(stage).toHaveAttribute('data-foil', 'holo')
  expect(state.puts.at(-1)).toEqual({ foil_pattern: null })
})

test('a printing-detail tag that names a pattern beats the rules, and the copy beats the tag', async ({ page }) => {
  const state = await installFixtures(page, { printingDetails: [{ id: 11, name: 'Cosmos', usage_count: 1 }] })
  const { dialog, stage } = await openSheet(page)
  await expect(stage).toHaveAttribute('data-foil', 'cosmos')
  await expect(stage).toHaveAttribute('data-foil-source', 'tag')
  await expect(dialog.getByTestId('foil-explanation')).toContainText('From your tag "Cosmos"')
  await expect(dialog.getByTestId('foil-explanation')).toContainText('Automatic would be Holo')

  await dialog.getByRole('button', { name: /Foil pattern/ }).click()
  await dialog.getByRole('radio', { name: /Cracked ice/ }).click()
  await expect(stage).toHaveAttribute('data-foil', 'cracked-ice')
  expect(state.puts.at(-1)).toEqual({ foil_pattern: 'cracked-ice' })
})

test('Reduce Motion: static sheen, no tilt, flip without animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await installFixtures(page)
  const { dialog, stage } = await openSheet(page)
  const box = await settledBox(stage)
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.3, { steps: 8 })
  await page.waitForTimeout(200)
  expect(parseFloat(await cssVar(stage, '--rotate-x'))).toBe(0)
  await expect(dialog.getByTestId('holo-motion')).toHaveCount(0)

  await dialog.getByTestId('holo-flip').click()
  await expect(stage).toHaveAttribute('data-flipped', 'true')
  await expect(stage).not.toHaveClass(/is-flipping/)
})

test('nothing animates while the card is at rest', async ({ page }) => {
  await installFixtures(page)
  const { stage } = await openSheet(page)
  const animations = await stage.evaluate(el => el.getAnimations({ subtree: true }).length)
  expect(animations).toBe(0)
})

// Frame rate while dragging. Opt in with HOLO_PERF=1; WebKit has no CPU-throttle API, so the
// throttle is applied on Chromium through CDP and WebKit is measured unthrottled.
test('measures the frame rate during a drag', async ({ page, browserName }, testInfo) => {
  test.skip(!process.env.HOLO_PERF, 'set HOLO_PERF=1 to measure')
  await installFixtures(page)
  const { stage } = await openSheet(page)
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.HOLO_THROTTLE || 4) })
  }
  const box = await settledBox(stage)
  await page.evaluate(() => {
    window.__frames = []
    const loop = (t) => { window.__frames.push(t); window.__running && requestAnimationFrame(loop) }
    window.__running = true
    requestAnimationFrame(loop)
  })
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  for (let i = 0; i < 120; i += 1) {
    const angle = i / 8
    await page.mouse.move(box.x + box.width * (0.5 + 0.4 * Math.cos(angle)), box.y + box.height * (0.5 + 0.4 * Math.sin(angle)))
    await page.waitForTimeout(8)
  }
  await page.mouse.up()
  const stats = await page.evaluate(() => {
    window.__running = false
    const f = window.__frames
    const durations = f.slice(1).map((t, i) => t - f[i])
    const total = f[f.length - 1] - f[0]
    return { fps: (f.length - 1) / (total / 1000), worst: Math.max(...durations) }
  })
  console.log(`HOLO_PERF ${testInfo.project.name} ${browserName} throttle=${process.env.HOLO_THROTTLE || 4}: ${stats.fps.toFixed(1)} fps, worst frame ${stats.worst.toFixed(0)} ms`)
  expect(stats.fps).toBeGreaterThan(20)
})
