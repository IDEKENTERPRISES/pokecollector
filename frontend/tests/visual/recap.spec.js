import { expect, test } from '@playwright/test'

// Home's weekly recap card (engagement P9a). Runs on desktop and mobile Chromium, and on iPhone
// WebKit through playwright.webkit.config.js. The API is mocked.

const USER = { id: 1, username: 'Recap Reviewer', role: 'admin', is_active: true, must_change_password: false }
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const RECAP = {
  week_start: '2026-10-26',
  week_end: '2026-11-01',
  week_key: '2026-W44',
  show: true,
  has_activity: true,
  cards_added: 7,
  value: { start: 100, end: 95.5, change: -4.5, percent: -4.5 },
  best_pull: { item_id: 21, card_id: 'a_en', name: 'Charizard', variant: 'Holo', image: '/api/images/card/a_en/small', price: 31.2 },
  closest_set: { set_id: 'base1_en', name: 'Base Set', owned: 100, total: 102, missing: 2 },
  streak: { current: 5, best: 9 },
  badges: [{ id: 'cards_10', tier: 'bronze' }],
}

const pad = n => String(n).padStart(2, '0')
const today = () => {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

async function install(page, { recap = RECAP, hideValues = false, showDaily = true } = {}) {
  await page.addInitScript(({ user, hide, daily }) => {
    localStorage.setItem('token', 'recap-test-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
    localStorage.setItem('pc.splash.enabled', '0')
    if (hide) localStorage.setItem('pc.hideValues', '1')
    if (!daily) localStorage.setItem('pc.progress.showDaily.v1', '0')
    window.__shared = []
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data) => { window.__shared.push((data.files || []).map(file => file.name)) },
    })
  }, { user: USER, hide: hideValues, daily: showDaily })
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path.startsWith('/api/pokedex/images/') || path.startsWith('/api/images/')) {
      return route.fulfill({ body: PNG, contentType: 'image/png' })
    }
    if (path === '/api/progress/recap/weekly') return route.fulfill({ json: recap })
    if (path === '/api/progress/today') {
      return route.fulfill({ json: { date: today(), streak: { current: 1, best: 1 }, quests: [{ id: 'view_pokemon', done: false }, { id: 'play_wtp', done: false }, { id: 'add_card', done: false }], xp: { xp: 10, level: 1, level_start: 0, next_level_at: 50 }, pokemon: { dex_id: 133, owned_printings: 1, cheapest: null }, wtp: { played: false, correct: false } } })
    }
    if (path === '/api/progress/unlocks/unseen') return route.fulfill({ json: { unlocks: [] } })
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

test('the recap shows the week, opens the best pull and the closest set', async ({ page }) => {
  await install(page)
  await page.goto('/')

  const card = page.getByTestId('weekly-recap')
  await expect(card).toBeVisible()
  await expect(page.getByTestId('recap-added')).toContainText('7')
  await expect(page.getByTestId('recap-value')).toContainText('4.50')
  await expect(page.getByTestId('recap-best-pull')).toContainText('Charizard')
  await expect(page.getByTestId('recap-best-pull')).toHaveAttribute('href', '/collection?itemId=21')
  await expect(page.getByTestId('recap-closest-set')).toContainText('Base Set: 2 to go')
  await expect(page.getByTestId('recap-closest-set')).toHaveAttribute('href', '/sets/base1_en')
  await expect(page.getByTestId('recap-streak')).toContainText('5-day streak')
  await expect(page.getByTestId('recap-badges')).toContainText('1 badge unlocked')
})

test('hide-values masks the amounts', async ({ page }) => {
  await install(page, { hideValues: true })
  await page.goto('/')

  const card = page.getByTestId('weekly-recap')
  await expect(card).toBeVisible()
  await expect(card).toContainText('••••')
  await expect(card).not.toContainText('4.50')
  await expect(card).not.toContainText('31.20')
})

test('the streak line follows the Show streaks and quests switch', async ({ page }) => {
  await install(page, { showDaily: false })
  await page.goto('/')

  await expect(page.getByTestId('weekly-recap')).toBeVisible()
  await expect(page.getByTestId('recap-streak')).toHaveCount(0)
})

test('the recap leaves no empty slot outside its window or for an empty week', async ({ page }) => {
  await install(page, { recap: { ...RECAP, show: false } })
  await Promise.all([page.waitForResponse(r => r.url().includes('/api/progress/recap/weekly')), page.goto('/')])
  await page.waitForTimeout(500)
  await expect(page.getByTestId('weekly-recap')).toHaveCount(0)
})

test('Share recap hands a picture to the share sheet', async ({ page }) => {
  await install(page)
  await page.goto('/')

  await page.getByRole('button', { name: 'Share recap' }).click()
  await expect.poll(() => page.evaluate(() => window.__shared)).toEqual([['weekly-recap.png']])
})
