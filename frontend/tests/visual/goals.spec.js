import { expect, test } from '@playwright/test'

// Chase goals (engagement P10): creating a goal, the Home ring card and the goal detail page.
// Runs on desktop and mobile Chromium, and on iPhone WebKit through playwright.webkit.config.js.
// The API is mocked.

const USER = { id: 1, username: 'Goal Reviewer', role: 'admin', is_active: true, must_change_password: false }
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const missing = (id, name, price) => ({
  id, card_id: id, name, set_id: 'swsh7', number: '75', lang: 'en', variant: null, price,
  images_small: null, images_large: null, custom_image_url: null, cardmarket_products: null,
})

const EEVEE = {
  id: 7,
  kind: 'family',
  params: { family: 'eeveelutions' },
  title: 'Eevee and all Eeveelutions',
  pinned: true,
  created_at: '2026-10-29T10:00:00',
  completed_at: null,
  progress: {
    owned: 9, total: 11, missing: 2, percent: 81.8, cost_to_finish: 46.5, unpriced_missing: 0,
    cheapest_missing: [missing('swsh7-75_en', 'Umbreon V', 12.5), missing('swsh7-41_en', 'Leafeon VMAX', 34)],
  },
}

async function install(page, { goals = [EEVEE], hideValues = false } = {}) {
  const state = { goals: [...goals], created: [], wishlistPosts: 0 }
  await page.addInitScript(({ user, hide }) => {
    localStorage.setItem('token', 'goals-test-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
    localStorage.setItem('pc.splash.enabled', '0')
    if (hide) localStorage.setItem('pc.hideValues', '1')
  }, { user: USER, hide: hideValues })
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    if (!path.startsWith('/api/')) return route.continue()
    if (path.startsWith('/api/pokedex/images/') || path.startsWith('/api/images/')) {
      return route.fulfill({ body: PNG, contentType: 'image/png' })
    }
    if (path === '/api/goals' && method === 'GET') return route.fulfill({ json: { goals: state.goals } })
    if (path === '/api/goals' && method === 'POST') {
      const body = request.postDataJSON()
      state.created.push(body)
      const goal = {
        ...EEVEE, id: 8, kind: body.kind, params: body.params, title: 'Generation 1 · Kanto', pinned: body.pinned,
        progress: { ...EEVEE.progress, owned: 40, total: 100, missing: 60, percent: 40, cost_to_finish: 99 },
      }
      state.goals = [...state.goals, goal]
      return route.fulfill({ status: 201, json: goal })
    }
    if (path === '/api/goals/options') {
      return route.fulfill({
        json: {
          generations: [{ generation: 1, region: 'Kanto', species: 151 }, { generation: 2, region: 'Johto', species: 100 }],
          families: [{ id: 'eeveelutions', name: 'Eevee and all Eeveelutions', dex_ids: [133, 134] }],
        },
      })
    }
    if (path === '/api/goals/7' && method === 'GET') return route.fulfill({ json: EEVEE })
    if (path === '/api/goals/7/wishlist' && method === 'GET') return route.fulfill({ json: { to_add: 2 } })
    if (path === '/api/goals/7/wishlist' && method === 'POST') {
      state.wishlistPosts += 1
      return route.fulfill({ json: { added: 2 } })
    }
    if (path === '/api/progress/today') {
      return route.fulfill({ json: { date: '2026-10-29', streak: { current: 1, best: 1 }, quests: [], xp: { xp: 10, level: 1, level_start: 0, next_level_at: 50 }, pokemon: { dex_id: 133, owned_printings: 1, cheapest: null }, wtp: { played: false, correct: false } } })
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
  return state
}

test('a pinned goal shows as a ring card on Home and opens its detail page', async ({ page }) => {
  await install(page)
  await page.goto('/')

  const card = page.getByTestId('goal-card-7')
  await expect(card).toBeVisible()
  await expect(card).toContainText('Eevee and all Eeveelutions')
  await expect(card).toContainText('81%')
  await expect(card).toContainText('46.50')
  await card.click()

  await expect(page).toHaveURL(/\/goals\/7$/)
  const summary = page.getByTestId('goal-summary')
  await expect(summary).toContainText('9 of 11')
  await expect(page.getByTestId('goal-cost')).toContainText('46.50')
  await expect(page.getByTestId('goal-missing-swsh7-75_en')).toContainText('Umbreon V')
  await expect(page.getByTestId('goal-missing-swsh7-41_en')).toContainText('34.00')
})

test('an unpinned goal stays off Home', async ({ page }) => {
  await install(page, { goals: [{ ...EEVEE, pinned: false }] })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Goal Reviewer' }).or(page.getByText('Goal Reviewer').first())).toBeVisible()
  await page.waitForTimeout(500)
  await expect(page.getByTestId('goal-card-7')).toHaveCount(0)
})

test('Profile has a Goals row, so goals are reachable with none pinned', async ({ page }) => {
  await install(page, { goals: [] })
  await page.goto('/profile')
  await expect(page.getByTestId('profile-goals')).toHaveAttribute('href', '/goals')
})

test('creating a goal from the picker adds it to the list', async ({ page }) => {
  const state = await install(page, { goals: [] })
  await page.goto('/goals')

  await expect(page.getByTestId('goals-empty')).toBeVisible()
  await page.getByRole('button', { name: 'New goal' }).first().click()
  await page.getByTestId('kind-generation').click()
  await page.getByTestId('pick-generation-1').click()

  await expect(page.getByTestId('goal-row-8')).toContainText('Generation 1 · Kanto')
  expect(state.created).toEqual([{ kind: 'generation', params: { generation: 1 }, pinned: true }])
})

test('adding the missing cards to the wishlist asks with a count first', async ({ page }) => {
  const state = await install(page)
  await page.goto('/goals/7')

  await page.getByTestId('goal-wishlist').click()
  await expect(page.getByText('Add 2 missing cards to your wishlist?')).toBeVisible()
  expect(state.wishlistPosts).toBe(0)
  await page.getByRole('button', { name: 'Add missing to wishlist' }).last().click()
  await expect.poll(() => state.wishlistPosts).toBe(1)
})

test('hide-values masks every amount', async ({ page }) => {
  await install(page, { hideValues: true })
  await page.goto('/')
  const card = page.getByTestId('goal-card-7')
  await expect(card).toBeVisible()
  await expect(card).not.toContainText('46.50')
  await card.click()
  await expect(page.getByTestId('goal-cost')).not.toContainText('46.50')
  await expect(page.getByTestId('goal-missing-swsh7-41_en')).not.toContainText('34.00')
  await expect(page.getByTestId('goal-missing-swsh7-41_en')).toContainText('••••')
})
