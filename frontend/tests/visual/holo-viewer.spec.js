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

// ---------------------------------------------------------------------------------------------
// Translucency: the foil may tint and sparkle, but the artwork must stay readable under it.
// The fixture's artwork is /cardback.jpg, a detailed known image. Screenshot the artwork with the
// foil layers hidden and with them showing, then compare the two in the page: the structure of the
// art (luminance correlation) has to survive, and the average change has to stay small. An opaque
// coat of paint (the WebKit blend-mode fallback bug) fails both.
// ---------------------------------------------------------------------------------------------

const ALL_PATTERNS = [
  'holo', 'reverse', 'cracked-ice', 'cosmos', 'etched', 'rainbow', 'gold', 'pokeball-reverse', 'radiant',
  'amazing', 'v-full-art', 'vmax', 'vstar', 'trainer-gallery', 'shiny', 'illustration-rare', 'special-illustration',
]
const MIN_ART_CORRELATION = 0.75
const MAX_MEAN_DIFF = 50 // of 255, averaged over the artwork's pixels and channels

async function waitForArt(locator) {
  await expect.poll(() => locator.locator('img').first().evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true)
}

async function compareArtWithFoil(page, art, setFoil = () => {}) {
  // A clipped page screenshot: an element screenshot waits for the card to be "stable", which the
  // idle sheen never is on a slow CI runner.
  const clip = await art.boundingBox()
  const shot = async () => (await page.screenshot({ clip, animations: 'disabled' })).toString('base64')
  const layers = art.locator('.holo-shine, .holo-glare')
  const setLayers = (visibility) => layers.evaluateAll((els, v) => els.forEach(el => { el.style.visibility = v }), visibility)
  await setLayers('hidden')
  await page.waitForTimeout(80)
  const bare = await shot()
  await setFoil()
  await setLayers('visible')
  await page.waitForTimeout(80)
  const foiled = await shot()
  return page.evaluate(async ([a, b]) => {
    const load = async (b64) => {
      const image = new Image()
      image.src = `data:image/png;base64,${b64}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0)
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data
    }
    const [x, y] = await Promise.all([load(a), load(b)])
    let diff = 0
    const lx = []
    const ly = []
    for (let i = 0; i < x.length; i += 4) {
      diff += (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2])) / 3
      lx.push(0.299 * x[i] + 0.587 * x[i + 1] + 0.114 * x[i + 2])
      ly.push(0.299 * y[i] + 0.587 * y[i + 1] + 0.114 * y[i + 2])
    }
    const n = lx.length
    const mx = lx.reduce((s, v) => s + v, 0) / n
    const my = ly.reduce((s, v) => s + v, 0) / n
    let sxy = 0
    let sxx = 0
    let syy = 0
    for (let i = 0; i < n; i += 1) {
      sxy += (lx[i] - mx) * (ly[i] - my)
      sxx += (lx[i] - mx) ** 2
      syy += (ly[i] - my) ** 2
    }
    return { meanDiff: diff / n, correlation: sxy / Math.sqrt(sxx * syy || 1) }
  }, [bare, foiled])
}

test('every foil pattern is a translucent sheen: the card art shows through it', async ({ page }, testInfo) => {
  test.setTimeout(120_000) // two screenshots for each of the 17 patterns
  await installFixtures(page)
  const { stage } = await openSheet(page)
  await settledBox(stage)
  const art = stage.locator('.unified-card-art')
  await waitForArt(art)
  for (const pattern of ALL_PATTERNS) {
    const result = await compareArtWithFoil(page, art, () => stage.evaluate((el, p) => el.setAttribute('data-foil', p), pattern))
    console.log(`HOLO_ART ${testInfo.project.name} ${pattern}: correlation ${result.correlation.toFixed(3)}, mean diff ${result.meanDiff.toFixed(1)}`)
    expect(result.correlation, `${pattern} hides the art`).toBeGreaterThan(MIN_ART_CORRELATION)
    expect(result.meanDiff, `${pattern} covers the art`).toBeLessThan(MAX_MEAN_DIFF)
  }
})

test('at full tilt (drag and device motion) the foil is at its strongest and still not opaque', async ({ page }) => {
  await installFixtures(page)
  const { stage } = await openSheet(page)
  const box = await settledBox(stage)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.1, { steps: 10 })
  await expect.poll(async () => parseFloat(await cssVar(stage, '--card-opacity'))).toBeGreaterThan(0.7)
  expect(parseFloat(await cssVar(stage, '--card-opacity'))).toBeLessThan(0.9)
  const opacity = parseFloat(await stage.locator('.holo-shine').evaluate(el => getComputedStyle(el).opacity))
  expect(opacity).toBeLessThan(0.9)
  await page.mouse.up()
})

test('WebKit uses the translucent foil with no backdrop blending; the rest keep their blend modes', async ({ page, browserName }) => {
  await installFixtures(page)
  const { stage } = await openSheet(page)
  const engine = browserName === 'webkit' ? 'webkit' : 'default'
  await expect(stage).toHaveAttribute('data-engine', engine)
  const styles = await Promise.all([stage.locator('.holo-shine'), stage.locator('.holo-glare')].map(l => l.evaluate((el) => {
    const s = getComputedStyle(el)
    return { blend: s.mixBlendMode, opacity: parseFloat(s.opacity), filter: s.filter }
  })))
  if (engine === 'webkit') {
    for (const s of styles) {
      expect(s.blend).toBe('normal')
      expect(s.filter).toBe('none')
      expect(s.opacity).toBeLessThanOrEqual(0.4)
    }
  } else {
    expect(styles[0].blend).toBe('color-dodge')
  }
  // The 3D context is only on while a flip needs it: no preserve-3d between the face and the foil.
  expect(await stage.locator('.holo__rotator').evaluate(el => getComputedStyle(el).transformStyle)).toBe('flat')
  expect(await stage.locator('.holo__front').evaluate(el => getComputedStyle(el).willChange)).toBe('auto')
})

test('the zoom overlay shows the same foil on the enlarged card', async ({ page }) => {
  await installFixtures(page)
  const { stage } = await openSheet(page)
  await settledBox(stage)
  await stage.getByRole('button', { name: /Zoom image/ }).click()
  const zoom = page.getByRole('dialog', { name: /Zoom image/ })
  await expect(zoom).toBeVisible()
  const card = zoom.getByTestId('zoom-holo')
  await expect(card).toHaveAttribute('data-foil', 'holo')
  await expect(card.locator('.holo-shine')).toHaveCount(1)
  await expect(card.locator('.holo-glare')).toHaveCount(1)
  await expect(card.locator('img')).toBeVisible()
  await waitForArt(card)
  const opacity = parseFloat(await card.locator('.holo-shine').evaluate(el => getComputedStyle(el).opacity))
  expect(opacity).toBeGreaterThan(0)
  expect(opacity).toBeLessThan(0.9)

  // The foil layers cover exactly the image.
  const imgBox = await card.locator('img').boundingBox()
  const shineBox = await card.locator('.holo-shine').boundingBox()
  expect(Math.abs(shineBox.width - imgBox.width)).toBeLessThan(2)
  expect(Math.abs(shineBox.height - imgBox.height)).toBeLessThan(2)

  // The art still shows through in the zoomed card.
  const result = await compareArtWithFoil(page, card)
  expect(result.correlation).toBeGreaterThan(MIN_ART_CORRELATION)
  expect(result.meanDiff).toBeLessThan(MAX_MEAN_DIFF)

  await page.keyboard.press('Escape')
  await expect(zoom).toHaveCount(0)
})

test('Reduce Motion keeps a still, translucent sheen in the sheet and the zoom', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await installFixtures(page)
  const { stage } = await openSheet(page)
  await settledBox(stage)
  const art = stage.locator('.unified-card-art')
  await waitForArt(art)
  const layer = stage.locator('.holo-shine')
  await expect(layer).toHaveCount(1)
  expect(parseFloat(await layer.evaluate(el => getComputedStyle(el).opacity))).toBeGreaterThan(0)
  const result = await compareArtWithFoil(page, art)
  expect(result.correlation).toBeGreaterThan(MIN_ART_CORRELATION)
  expect(result.meanDiff).toBeLessThan(MAX_MEAN_DIFF)

  await stage.getByRole('button', { name: /Zoom image/ }).click()
  const zoom = page.getByRole('dialog', { name: /Zoom image/ })
  await expect(zoom.getByTestId('zoom-holo').locator('.holo-shine')).toHaveCount(1)
  expect(await zoom.getByTestId('zoom-holo').evaluate(el => el.getAnimations({ subtree: true }).length)).toBe(0)
})

// ---------------------------------------------------------------------------------------------
// Texture scale: the foil's tile sizes follow the rendered card, so the zoomed (bigger) card shows
// the same number of repeats as the card in the sheet instead of many more. Computed styles only:
// no screenshots, so it stays fast and never waits for the idle sheen to be "stable".
// ---------------------------------------------------------------------------------------------

// The first tile of the patterned layer: pokeball-reverse is a mask, the others tile their first
// background image.
const PATTERN_TILES = [
  { pattern: 'pokeball-reverse', property: 'mask' },
  { pattern: 'cracked-ice', property: 'background' },
  { pattern: 'v-full-art', property: 'background' },
]

// Computed tile size in px, the card's layout width (ignores the zoom overlay's CSS transform) and
// the --holo-scale the app wrote.
async function readTile(card, property) {
  return card.evaluate((root, prop) => {
    const style = getComputedStyle(root.querySelector('.holo-shine'))
    const value = prop === 'mask' ? (style.maskSize || style.webkitMaskSize) : style.backgroundSize
    return {
      raw: value,
      tile: parseFloat(value.split(/[ ,]/)[0]),
      width: root.offsetWidth,
      scale: parseFloat(root.style.getPropertyValue('--holo-scale')),
    }
  }, property)
}

test('foil textures scale with the card: the sheet and the zoom show the same number of repeats', async ({ page }, testInfo) => {
  await installFixtures(page)
  const { stage } = await openSheet(page)
  await settledBox(stage)
  const inSheet = {}
  for (const { pattern, property } of PATTERN_TILES) {
    await stage.evaluate((el, p) => el.setAttribute('data-foil', p), pattern)
    inSheet[pattern] = await readTile(stage, property)
  }

  await stage.getByRole('button', { name: /Zoom image/ }).click()
  const zoom = page.getByRole('dialog', { name: /Zoom image/ })
  const card = zoom.getByTestId('zoom-holo')
  await expect(card).toBeVisible()
  // --holo-scale is the card's width over the 130 px reference; wait until it matches the zoom card.
  await expect.poll(() => card.evaluate(el => Math.abs(parseFloat(el.style.getPropertyValue('--holo-scale')) * 130 - el.offsetWidth))).toBeLessThan(1)
  const zoomWidth = await card.evaluate(el => el.offsetWidth)
  console.log(`HOLO_SCALE ${testInfo.project.name}: sheet card ${inSheet['pokeball-reverse'].width}px, zoom card ${zoomWidth}px`)

  for (const { pattern, property } of PATTERN_TILES) {
    await card.evaluate((el, p) => el.setAttribute('data-foil', p), pattern)
    const zoomed = await readTile(card, property)
    const sheet = inSheet[pattern]
    expect(sheet.tile, `${pattern} has a tile size in the sheet (${sheet.raw})`).toBeGreaterThan(0)
    expect(zoomed.tile, `${pattern} has a tile size in the zoom (${zoomed.raw})`).toBeGreaterThan(0)
    const sheetRepeats = sheet.tile / sheet.width
    const zoomRepeats = zoomed.tile / zoomed.width
    expect(
      Math.abs(zoomRepeats / sheetRepeats - 1),
      `${pattern}: tile / card width is ${sheetRepeats.toFixed(4)} in the sheet and ${zoomRepeats.toFixed(4)} zoomed`,
    ).toBeLessThan(0.05)
  }

  // Zooming with + (or a pinch) enlarges the card with a CSS transform, which scales the painted
  // textures by itself: the variable and the computed tile size must not change with it.
  await card.evaluate(el => el.setAttribute('data-foil', 'pokeball-reverse'))
  const before = await readTile(card, 'mask')
  await zoom.getByRole('button', { name: /Zoom in/ }).click()
  await expect.poll(() => card.evaluate(el => el.style.transform)).toContain('scale(1.75)')
  const after = await readTile(card, 'mask')
  expect(after.scale).toBe(before.scale)
  expect(after.tile).toBeCloseTo(before.tile, 1)
})

// ---------------------------------------------------------------------------------------------
// Phone tilt in the zoom: once "Tilt with your phone" is on in the sheet, the zoomed card's foil and
// glare keep following the phone's orientation. The card itself never rotates (pinch and pan own
// the touch), nothing asks for permission again, and the listener goes away with the overlay.
// Computed styles only.
// ---------------------------------------------------------------------------------------------

// Pretend to be iOS (a permission API, already granted) so the "Tilt with your phone" button shows,
// and count the deviceorientation listeners so tidy-up can be checked.
async function installOrientationStubs(page) {
  await page.addInitScript(() => {
    window.__permissionRequests = 0
    window.DeviceOrientationEvent.requestPermission = async () => {
      window.__permissionRequests += 1
      return 'granted'
    }
    // A Set, like the DOM's own listener list: adding twice or removing a stranger changes nothing.
    const handlers = new Set()
    Object.defineProperty(window, '__orientationListeners', { get: () => handlers.size })
    const add = window.addEventListener.bind(window)
    const remove = window.removeEventListener.bind(window)
    window.addEventListener = (type, handler, ...rest) => {
      if (type === 'deviceorientation') handlers.add(handler)
      return add(type, handler, ...rest)
    }
    window.removeEventListener = (type, handler, ...rest) => {
      if (type === 'deviceorientation') handlers.delete(handler)
      return remove(type, handler, ...rest)
    }
  })
}

// WebKit's DeviceOrientationEvent has no public constructor (the app only reads beta and gamma), so
// fall back to a plain event that carries them.
const tilt = (page, beta, gamma) => page.evaluate(([b, g]) => {
  let event
  try {
    event = new DeviceOrientationEvent('deviceorientation', { beta: b, gamma: g })
  } catch {
    event = new Event('deviceorientation')
    Object.defineProperties(event, { beta: { value: b }, gamma: { value: g } })
  }
  window.dispatchEvent(event)
}, [beta, gamma])

async function openZoomWithTilt(page, { reduceMotionAfterEnable = false } = {}) {
  await installOrientationStubs(page)
  await installFixtures(page)
  const { dialog, stage } = await openSheet(page)
  await settledBox(stage)
  await dialog.getByTestId('holo-motion').click()
  await expect(dialog.getByTestId('holo-motion')).toHaveAttribute('aria-pressed', 'true')
  if (reduceMotionAfterEnable) await page.emulateMedia({ reducedMotion: 'reduce' })
  await stage.getByRole('button', { name: /Zoom image/ }).click()
  const zoom = page.getByRole('dialog', { name: /Zoom image/ })
  const card = zoom.getByTestId('zoom-holo')
  await expect(card).toBeVisible()
  return { zoom, card }
}

test('the zoomed card follows the phone tilt when it is on, as foil only', async ({ page }) => {
  const { zoom, card } = await openZoomWithTilt(page)
  // Resting sheen until the phone moves.
  expect(await cssVar(card, '--pointer-x')).toBe('30.0%')

  // The first reading is the reference pose; later readings move the sheen away from it.
  await tilt(page, 40, 0)
  await tilt(page, 40, 25)
  await expect.poll(async () => parseFloat(await cssVar(card, '--pointer-x'))).toBeGreaterThan(70)
  await tilt(page, 40, -25)
  await expect.poll(async () => parseFloat(await cssVar(card, '--pointer-x'))).toBeLessThan(30)
  await tilt(page, 65, -25)
  await expect.poll(async () => parseFloat(await cssVar(card, '--pointer-y'))).toBeGreaterThan(70)
  expect(parseFloat(await cssVar(card, '--pointer-from-left'))).toBeLessThan(0.3)
  expect(parseFloat(await cssVar(card, '--background-y'))).toBeGreaterThan(55)

  // Strongest foil, still translucent (the opacity cap and the WebKit path from the still sheen).
  const strength = parseFloat(await cssVar(card, '--card-opacity'))
  expect(strength).toBeGreaterThan(0.7)
  expect(strength).toBeLessThan(0.9)
  const shine = parseFloat(await card.locator('.holo-shine').evaluate(el => getComputedStyle(el).opacity))
  expect(shine).toBeGreaterThan(0)
  expect(shine).toBeLessThan(0.9)

  // Foil only: the zoomed card is never rotated, and no second permission prompt.
  expect(await card.evaluate(el => el.style.transform)).not.toMatch(/rotate/)
  expect(await page.evaluate(() => window.__permissionRequests)).toBe(1)

  // The +/- zoom still works while it follows.
  await zoom.getByRole('button', { name: /Zoom in/ }).click()
  await expect.poll(() => card.evaluate(el => el.style.transform)).toContain('scale(1.75)')

  // Closing the zoom removes its listener; the sheet's own stays until Tilt is turned off.
  const before = await page.evaluate(() => window.__orientationListeners)
  await page.keyboard.press('Escape')
  await expect(zoom).toHaveCount(0)
  expect(await page.evaluate(() => window.__orientationListeners)).toBe(before - 1)
})

test('the zoom stays a still sheen when Tilt with your phone is off', async ({ page }) => {
  await installOrientationStubs(page)
  await installFixtures(page)
  const { stage } = await openSheet(page)
  await settledBox(stage)
  await stage.getByRole('button', { name: /Zoom image/ }).click()
  const card = page.getByRole('dialog', { name: /Zoom image/ }).getByTestId('zoom-holo')
  await expect(card).toBeVisible()
  await tilt(page, 40, 0)
  await tilt(page, 40, 25)
  await page.waitForTimeout(300)
  expect(await cssVar(card, '--pointer-x')).toBe('30.0%')
  expect(await page.evaluate(() => window.__orientationListeners)).toBe(0)
})

test('Reduce Motion: the zoomed foil ignores the phone tilt', async ({ page }) => {
  const { card } = await openZoomWithTilt(page, { reduceMotionAfterEnable: true })
  await tilt(page, 40, 0)
  await tilt(page, 40, 25)
  await page.waitForTimeout(300)
  expect(await cssVar(card, '--pointer-x')).toBe('30.0%')
  expect(parseFloat(await cssVar(card, '--card-opacity'))).toBeLessThan(0.6)
})
