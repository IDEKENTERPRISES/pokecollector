import { expect, test } from '@playwright/test'

// The 2026 Wrapped story (engagement P9b): Home banner, tapping through, back, a skipped empty slide,
// Reduce Motion, hide-values and the share picker. Runs on desktop and mobile Chromium, and on iPhone
// WebKit through playwright.webkit.config.js. The API is mocked.

const USER = { id: 1, username: 'Ash', role: 'admin', is_active: true, must_change_password: false }
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const WRAPPED = {
  year: 2026,
  history_starts: '2026-03-12',
  partial_history: true,
  totals: { cards: 486, unique_cards: 312, sets_touched: 41, sets_completed: 6 },
  first_card: { item_id: 1, card_id: 'e_en', name: 'Eevee', variant: 'Holo', image: '/api/images/card/e_en/small' },
  best_pull: { item_id: 2, card_id: 'u_en', name: 'Umbreon ex', variant: 'Holo', image: '/api/images/card/u_en/small', price: 182.5 },
  biggest_month: { month: 6, count: 88 },
  monthly: [24, 38, 20, 43, 59, 88, 41, 30, 52, 61, 22, 8],
  top_pokemon: { dex_id: 133, name: 'Eevee', count: 23 },
  top_type: { type: 'psychic', count: 150 },
  top_illustrator: { name: 'Mitsuhiro Arita', count: 31 },
  value: { start: 900, end: 1400, peak: 1520, peak_date: '2026-10-12' },
  longest_streak: 41,
  wtp_wins: 112,
  quests_done: 260,
  badges_earned: 18,
  trades: { count: 4, incoming_value: 50, outgoing_value: 40 },
  products: { count: 2, spent: 30 },
}

async function install(page, { wrapped = WRAPPED, hideValues = false, reduceMotion = true } = {}) {
  await page.emulateMedia({ reducedMotion: reduceMotion ? 'reduce' : 'no-preference' })
  await page.addInitScript(({ user, hide }) => {
    localStorage.setItem('token', 'wrapped-test-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
    localStorage.setItem('pc.splash.enabled', '0')
    if (hide) localStorage.setItem('pc.hideValues', '1')
    window.__shared = []
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data) => { window.__shared.push((data.files || []).map(file => file.name)) },
    })
  }, { user: USER, hide: hideValues })
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path.startsWith('/api/pokedex/images/') || path.startsWith('/api/images/')) {
      return route.fulfill({ body: PNG, contentType: 'image/png' })
    }
    if (path === '/api/progress/wrapped') {
      return wrapped
        ? route.fulfill({ json: wrapped })
        : route.fulfill({ status: 404, json: { detail: 'Wrapped is not available yet' } })
    }
    if (path === '/api/progress/today') {
      return route.fulfill({ json: { date: '2026-12-02', streak: { current: 1, best: 1 }, quests: [], xp: { xp: 10, level: 1, level_start: 0, next_level_at: 50 }, pokemon: { dex_id: 133, owned_printings: 1, cheapest: null }, wtp: { played: false, correct: false } } })
    }
    if (path === '/api/progress/unlocks/unseen') return route.fulfill({ json: { unlocks: [] } })
    if (path === '/api/progress/recap/weekly') return route.fulfill({ json: { show: false, has_activity: false } })
    const responses = {
      '/api/auth/mode': { multi_user: false },
      '/api/auth/me': USER,
      '/api/settings/': { language: 'en', price_primary: 'trend', currency: 'EUR', tcgdex_sync_languages: 'en' },
      '/api/settings/tcgdex-filter-languages': ['en'],
      '/api/profile/': { feature_enabled: false, is_profile_public: false },
      '/api/dashboard/': { total_cards: 12, unique_cards: 3, owned_sets: 1, recent_additions: [], top_cards: [] },
      '/api/wishlist/': [],
      '/api/sets/': [],
      '/api/binders/': [],
    }
    return route.fulfill({ json: responses[path] ?? {} })
  })
}

const story = page => page.getByTestId('wrapped-story')
const slide = page => story(page).getAttribute('data-slide')

async function playToEnd(page) {
  const seen = [await slide(page)]
  for (let guard = 0; guard < 12; guard += 1) {
    const next = page.getByRole('button', { name: 'Next slide' })
    if (await next.isDisabled()) break
    await next.click()
    seen.push(await slide(page))
  }
  return seen
}

test('the Home banner opens the story, and it taps through and back', async ({ page }) => {
  await install(page)
  await page.goto('/')

  await page.getByTestId('wrapped-banner').click()
  await expect(page).toHaveURL(/\/wrapped\/2026$/)
  await expect(story(page)).toHaveAttribute('data-slide', 'cover')
  await expect(story(page)).toContainText('YOUR YEAR IN CARDS')
  await expect(story(page)).toContainText('Collected since 12 March')

  await page.getByRole('button', { name: 'Next slide' }).click()
  await expect(story(page)).toHaveAttribute('data-slide', 'cards')
  await expect(story(page)).toContainText('486')
  await expect(story(page)).toContainText('June · 88')

  await page.getByRole('button', { name: 'Next slide' }).click()
  await expect(story(page)).toHaveAttribute('data-slide', 'first')
  await expect(story(page)).toContainText('Your first card of 2026')

  await page.getByRole('button', { name: 'Previous slide' }).click()
  await expect(story(page)).toHaveAttribute('data-slide', 'cards')
  await page.getByRole('button', { name: 'Previous slide' }).click()
  await expect(story(page)).toHaveAttribute('data-slide', 'cover')
  await expect(page.getByRole('button', { name: 'Previous slide' })).toBeDisabled()

  await page.getByRole('button', { name: 'Close Wrapped' }).click()
  await expect(page).toHaveURL(/\/$/)
})

test('all ten slides play in order and Watch again restarts', async ({ page }) => {
  await install(page)
  await page.goto('/wrapped')

  const seen = await playToEnd(page)
  expect(seen).toEqual(['cover', 'cards', 'first', 'pull', 'favourites', 'sets', 'value', 'streak', 'badges', 'summary'])
  await expect(page.getByRole('button', { name: 'Next slide' })).toBeDisabled()
  await page.getByTestId('wrapped-restart').click()
  await expect(story(page)).toHaveAttribute('data-slide', 'cover')
})

test('a slide with no data is skipped', async ({ page }) => {
  await install(page, { wrapped: { ...WRAPPED, badges_earned: 0, trades: { count: 0 }, products: { count: 0 } } })
  await page.goto('/wrapped')

  const seen = await playToEnd(page)
  expect(seen).toHaveLength(9)
  expect(seen).not.toContain('badges')
  expect(seen.at(-1)).toBe('summary')
})

test('Reduce Motion: nothing advances or animates by itself', async ({ page }) => {
  await install(page, { reduceMotion: true })
  await page.goto('/wrapped')

  const progress = page.getByTestId('wrapped-progress')
  await expect(progress).toBeVisible()
  expect(await progress.evaluate(el => getComputedStyle(el).animationName)).toBe('none')
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.wrapped-slide')).animationName)).toBe('none')
  await page.waitForTimeout(1500)
  await expect(story(page)).toHaveAttribute('data-slide', 'cover')
})

test('without Reduce Motion the progress segment runs for six seconds and pauses on press', async ({ page }) => {
  await install(page, { reduceMotion: false })
  await page.goto('/wrapped')

  const progress = page.getByTestId('wrapped-progress')
  expect(await progress.evaluate(el => getComputedStyle(el).animationName)).toBe('wrapped-fill')
  expect(await progress.evaluate(el => getComputedStyle(el).animationDuration)).toBe('6s')
  await page.evaluate(() => document.querySelector('[data-testid="wrapped-story"]').dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, clientX: 200, clientY: 300 }),
  ))
  await expect.poll(() => progress.evaluate(el => getComputedStyle(el).animationPlayState)).toBe('paused')
})

test('hide-values masks every amount in the story', async ({ page }) => {
  await install(page, { hideValues: true })
  await page.goto('/wrapped')

  for (let i = 0; i < 3; i += 1) await page.getByRole('button', { name: 'Next slide' }).click()
  await expect(story(page)).toHaveAttribute('data-slide', 'pull')
  await expect(page.getByTestId('wrapped-pull-value')).toHaveText('€•••')
  for (let i = 0; i < 3; i += 1) await page.getByRole('button', { name: 'Next slide' }).click()
  await expect(story(page)).toHaveAttribute('data-slide', 'value')
  await expect(page.getByTestId('wrapped-value')).toHaveText('€•••')
  await expect(story(page)).not.toContainText('1.4k')
  await expect(story(page)).not.toContainText('1,400')
  await expect(story(page)).not.toContainText('1.400')
})

test('Share my trainer card opens the picker, and a tap shares that picture', async ({ page }) => {
  await install(page)
  await page.goto('/wrapped')

  await playToEnd(page)
  await page.getByRole('button', { name: 'Share my trainer card' }).click()
  await expect(page.getByTestId('wrapped-share-sheet')).toBeVisible()
  await expect(page.getByTestId('wrapped-share-card')).toHaveAttribute('data-ready', 'true', { timeout: 15000 })
  await page.getByTestId('wrapped-share-card').click()
  await expect.poll(() => page.evaluate(() => window.__shared)).toEqual([['pokecollector-wrapped-2026-trainer-card.png']])
  await expect(page.getByTestId('wrapped-share-sheet')).toHaveCount(0)
})

test('Profile has a Wrapped row', async ({ page }) => {
  await install(page)
  await page.goto('/profile')
  await expect(page.getByTestId('profile-wrapped')).toContainText('2026 Wrapped')
  await expect(page.getByTestId('profile-wrapped')).toHaveAttribute('href', '/wrapped/2026')
})

test('Home and Profile show no Wrapped entry when the API says it is not available', async ({ page }) => {
  await install(page, { wrapped: null })
  await Promise.all([page.waitForResponse(r => r.url().includes('/api/progress/wrapped')), page.goto('/')])
  await page.waitForTimeout(500)
  await expect(page.getByTestId('wrapped-banner')).toHaveCount(0)
  await page.goto('/profile')
  await page.waitForTimeout(500)
  await expect(page.getByTestId('profile-wrapped')).toHaveCount(0)
})
