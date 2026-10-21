import { expect, test } from '@playwright/test'

// The launch splash and the Pokémon of the day (frontend/src/components/splash). Automated
// browsers skip the splash unless a test opts in with pc.splash.e2e, which is why no other suite
// sees it.

const ADMIN = { id: 1, username: 'admin', role: 'admin', is_active: true, must_change_password: false, avatar_id: null }

// The facts are written for these tests, not taken from the games.
function dayEntry(date, overrides = {}) {
  return {
    date,
    dex_id: 133,
    name: 'Eevee',
    lang: 'en',
    generation: 1,
    region: 'Kanto',
    types: ['normal'],
    genus: 'Evolution Pokémon',
    height_m: 0.3,
    weight_kg: 6.5,
    shiny: false,
    facts: [
      { kind: 'hidden-ability', title: 'Anticipation', text: 'A test fact about its ability.' },
      { kind: 'evolution', text: 'A test fact about how it evolves.' },
      { kind: 'trait', text: 'A test fact about its species.' },
    ],
    sprite_url: '/api/pokedex/images/showdown/133.gif',
    sprite_style: 'animated',
    ...overrides,
  }
}

// A creature drawn for the tests: no game sprite is committed (size and IP).
const SPRITE = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="60" viewBox="0 0 32 30" shape-rendering="crispEdges">',
  '<rect x="9" y="2" width="14" height="2" fill="#f7c815"/>',
  '<rect x="5" y="4" width="22" height="16" fill="#f7c815"/>',
  '<rect x="7" y="20" width="18" height="6" fill="#e0a800"/>',
  '<rect x="10" y="9" width="4" height="4" fill="#1c1c21"/><rect x="18" y="9" width="4" height="4" fill="#1c1c21"/>',
  '<rect x="6" y="15" width="4" height="3" fill="#e3350d"/><rect x="22" y="15" width="4" height="3" fill="#e3350d"/>',
  '<rect x="7" y="26" width="6" height="4" fill="#8a5a00"/><rect x="19" y="26" width="6" height="4" fill="#8a5a00"/>',
  '</svg>',
].join('')

async function installApi(page, { splash = url => dayEntry(url.searchParams.get('date')), splashRequests = [], delay = 0 } = {}) {
  await page.addInitScript(() => {
    localStorage.setItem('pc.splash.e2e', '1')
    localStorage.setItem('app_language', 'en')
  })
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: false, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: ADMIN })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR', price_primary: 'trend' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/currencies') return route.fulfill({ json: { currencies: [{ code: 'EUR', name: 'Euro', symbol: '€' }] } })
    if (path === '/api/dashboard/') return route.fulfill({ json: { recent_additions: [], top_cards: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/analytics/investment-tracker') return route.fulfill({ json: [] })
    if (path === '/api/pokedex/summary') return route.fulfill({ json: { total: 1025, owned: 0, missing: 1025 } })
    if (path === '/api/pokedex/splash') {
      splashRequests.push(url)
      const body = splash(url)
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      if (!body) return route.abort('failed')
      return route.fulfill({ json: body, headers: { 'Cache-Control': 'no-store' } })
    }
    if (path.startsWith('/api/pokedex/images/')) {
      return route.fulfill({ body: SPRITE, contentType: 'image/svg+xml', headers: { 'Cache-Control': 'public, max-age=604800' } })
    }
    if (path.startsWith('/api/public/') || path.startsWith('/api/auth/invites/')) {
      return route.fulfill({ status: 404, json: { detail: 'Not found' } })
    }
    return route.fulfill({ json: {} })
  })
}

const splashOf = page => page.getByTestId('launch-splash')
// The browser runs in the test machine's time zone, so its local date is this one.
const localToday = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test.describe('launch splash', () => {
  test('shows once per launch, never on in-app navigation, and again after a reload', async ({ page }) => {
    await installApi(page)
    await page.goto('/')
    await expect(page.getByRole('dialog', { name: 'Welcome to PokéCollector' })).toBeVisible()
    await expect(page.locator('.pc-splash__name')).toHaveText('Eevee')
    // It opens the app by itself a while after the reveal.
    await expect(splashOf(page)).toHaveCount(0, { timeout: 12_000 })
    await expect(page.getByText('Hello,')).toBeVisible()

    await page.evaluate(() => {
      window.history.pushState({}, '', '/settings')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await expect(page.getByTestId('settings-section-appearance')).toBeVisible()
    await page.waitForTimeout(400)
    await expect(splashOf(page)).toHaveCount(0)

    await page.reload()
    await expect(splashOf(page)).toBeVisible()
  })

  test('skips on a tap or click anywhere, and focus goes back to the app', async ({ page, hasTouch }) => {
    await installApi(page)
    await page.goto('/')
    const splash = splashOf(page)
    await expect(splash).toBeVisible()
    await expect(page.locator('#root')).toHaveAttribute('inert', '')
    await expect(page.getByTestId('launch-splash-skip')).toBeFocused()

    const { width, height } = page.viewportSize()
    if (hasTouch) await page.touchscreen.tap(width / 2, height / 3)
    else await page.mouse.click(width / 2, height / 3)

    await expect(splash).toHaveCount(0, { timeout: 1500 })
    await expect(page.locator('#root')).not.toHaveAttribute('inert', '')
    expect(await page.evaluate(() => {
      const active = document.activeElement
      return !active || active === document.body || document.getElementById('root').contains(active)
    })).toBe(true)
  })

  test('skips on Escape, Enter or Space at any moment', async ({ page }) => {
    await installApi(page)
    await page.goto('/')
    for (const key of ['Escape', 'Enter', 'Space']) {
      await expect(splashOf(page)).toBeVisible()
      await page.keyboard.press(key)
      await expect(splashOf(page), key).toHaveCount(0, { timeout: 1500 })
      await page.reload()
    }
  })

  test('announces the Pokémon in a dialog with a focusable Skip button', async ({ page }) => {
    await installApi(page)
    await page.goto('/')
    const dialog = page.getByRole('dialog', { name: 'Welcome to PokéCollector' })
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
    await expect(page.getByTestId('launch-splash-skip')).toBeFocused()
    await expect(page.locator('.pc-splash__live')).toContainText(
      'A wild Eevee appeared! No. 133, Generation 1, Kanto. Height 0.3 metres, weight 6.5 kilograms, 14.3 pounds.',
      { timeout: 6000 },
    )
    const card = page.getByTestId('launch-splash-card')
    await expect(card).toContainText('No. 0133')
    await expect(card).toContainText('Evolution Pokémon · Gen 1 · Kanto')
    await expect(card).toContainText('0.3 m · 1′00″')
    await expect(card).toContainText('6.5 kg · 14.3 lbs')
    await expect(splashOf(page)).toHaveAttribute('data-ground', 'grass')
  })

  test('the Pokémon of the day: fetched by date, stored with tomorrow, then shown without asking again', async ({ page }) => {
    const splashRequests = []
    const requestedToday = localToday()
    await installApi(page, {
      splashRequests,
      splash: url => (url.searchParams.get('date') === requestedToday
        ? dayEntry(requestedToday)
        : dayEntry(url.searchParams.get('date'), { dex_id: 7, name: 'Squirtle', types: ['water'], sprite_url: '/api/pokedex/images/showdown/7.gif' })),
    })
    await page.goto('/')
    await expect(page.locator('.pc-splash__name')).toHaveText('Eevee')
    expect(splashRequests[0].searchParams.get('date')).toBe(requestedToday)
    expect(splashRequests[0].searchParams.get('lang')).toBe('en')
    await page.keyboard.press('Escape')
    // Tomorrow is fetched a few seconds after the splash closes.
    await expect.poll(
      () => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('pc.splash.days.v1') || '{}')).length),
      { timeout: 10_000 },
    ).toBe(2)

    const before = splashRequests.length
    await page.reload()
    await expect(page.locator('.pc-splash__name')).toHaveText('Eevee')
    await expect(page.locator('.pc-splash__sprite')).toHaveAttribute('src', /^blob:/)
    expect(splashRequests.length).toBe(before)
  })

  test('keeps twitching while today\'s Pokémon loads, then reveals it', async ({ page }) => {
    await installApi(page, { delay: 3200 })
    await page.goto('/')
    const splash = splashOf(page)
    await expect(splash).toBeVisible()
    await expect(page.locator('.pc-splash__wait.is-twitching')).toHaveCount(1, { timeout: 4000 })
    await expect(splash).toHaveAttribute('data-open', 'true', { timeout: 6000 })
    await expect(page.locator('.pc-splash__name')).toHaveText('Eevee')
  })

  test('the starter comes out when the server never answers', async ({ page }) => {
    await installApi(page, { splash: () => null })
    await page.goto('/')
    await expect(splashOf(page)).toHaveAttribute('data-open', 'true', { timeout: 8000 })
    await expect(page.locator('.pc-splash__name')).toHaveText('Pikachu')
  })

  test('a shiny day has sparkles and says so', async ({ page }) => {
    await installApi(page, { splash: url => dayEntry(url.searchParams.get('date'), { shiny: true, sprite_url: '/api/pokedex/images/showdown-shiny/133.gif' }) })
    await page.goto('/')
    await expect(splashOf(page)).toHaveAttribute('data-shiny', 'true')
    await expect(page.locator('.pc-splash__sparkle')).toHaveCount(4)
    await expect(page.getByTestId('launch-splash-card')).toContainText('★ Shiny')
    await expect(page.locator('.pc-splash__live')).toContainText('A wild shiny Eevee appeared!', { timeout: 6000 })
  })

  test('the Settings switch turns it off on this device', async ({ page }) => {
    await installApi(page)
    await page.goto('/settings/appearance')
    await expect(splashOf(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(splashOf(page)).toHaveCount(0)

    const toggle = page.getByRole('switch', { name: 'Splash screen on launch' })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(await page.evaluate(() => localStorage.getItem('pc.splash.enabled'))).toBe('0')

    await page.reload()
    await expect(toggle).toBeVisible()
    await page.waitForTimeout(400)
    await expect(splashOf(page)).toHaveCount(0)
  })

  test('Reduce Motion shows the revealed card, still, and a tap still skips', async ({ page }) => {
    await installApi(page)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    const splash = splashOf(page)
    await expect(splash).toHaveAttribute('data-mode', 'still')
    await expect(splash).toHaveAttribute('data-revealed', 'true', { timeout: 4000 })
    await expect(page.getByTestId('launch-splash-card')).toBeVisible()
    await expect(page.locator('.pc-splash__ball')).toBeHidden()
    await expect(page.locator('.pc-splash__flash')).toBeHidden()
    // No roll, twitch or flash: at most the gentle fade of the whole overlay.
    expect(await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length)).toBeLessThanOrEqual(1)
    await expect(splash).toHaveCount(0, { timeout: 5000 })

    await page.reload()
    await expect(splashOf(page)).toBeVisible()
    await splashOf(page).click()
    await expect(splashOf(page)).toHaveCount(0, { timeout: 1500 })
  })

  test('stays away after the update reload, and on public and invite pages', async ({ page }) => {
    await installApi(page)
    // What pwa/register.js sets right before the service worker's update reload.
    await page.addInitScript(() => {
      if (sessionStorage.getItem('test.suppressed')) return
      sessionStorage.setItem('test.suppressed', '1')
      sessionStorage.setItem('pc.splash.suppressOnce', '1')
    })
    await page.goto('/')
    await expect(page.getByText('Hello,')).toBeVisible()
    await expect(splashOf(page)).toHaveCount(0)
    await page.reload()
    await expect(splashOf(page)).toBeVisible()

    for (const path of ['/u/ash', '/invite/abc123']) {
      await page.goto(path)
      await page.waitForTimeout(500)
      await expect(splashOf(page), path).toHaveCount(0)
    }
  })
})

test('Home shows the Pokémon of the day with its facts and a link to its cards', async ({ page }) => {
  await installApi(page)
  await page.addInitScript(() => localStorage.setItem('pc.splash.enabled', '0'))
  await page.goto('/')
  const card = page.getByTestId('pokemon-of-the-day')
  await expect(card).toBeVisible()
  await expect(card.getByRole('heading', { name: 'Pokémon of the day' })).toBeVisible()
  await expect(card).toContainText('Eevee')
  await expect(card).toContainText('Hidden ability')
  await expect(card).toContainText('A test fact about how it evolves.')
  await expect(card.getByRole('link', { name: 'Its cards' })).toHaveAttribute('href', '/pokedex/133')
})

// Key frames for review: the preview at /__splash with the starter and a fixed sprite, every
// animation paused at the same moment. Linux snapshots only (Docker), like the other suites.
test.describe('launch splash key frames', () => {
  for (const [name, at] of [['rolled-in', 1150], ['open', 2600], ['revealed', 4300]]) {
    test(`splash ${name}`, async ({ page }) => {
      await installApi(page)
      await page.goto('/__splash?hold=1&controls=0')
      await expect(page.locator('.pc-splash__sprite-box')).toHaveAttribute('data-sized', 'true')
      await page.evaluate(time => {
        for (const animation of document.getAnimations()) {
          animation.pause()
          animation.currentTime = time
        }
      }, at)
      await expect(page).toHaveScreenshot(`splash-${name}.png`, { animations: 'allow' })
    })
  }
})
