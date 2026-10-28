import { expect, test } from '@playwright/test'

// Home's Today card and Who's That Pokémon (engagement P7). Runs on desktop and mobile Chromium, and
// on iPhone WebKit through playwright.webkit.config.js.

const USER = { id: 1, username: 'Daily Reviewer', role: 'admin', is_active: true, must_change_password: false }
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)

const pad = n => String(n).padStart(2, '0')
const today = () => {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

const entryFor = date => ({
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
  facts: [{ kind: 'trait', text: 'It can evolve in many ways.' }],
  sprite_url: '/api/pokedex/images/showdown/133.gif',
  sprite_style: 'animated',
})

const puzzleFor = date => ({
  date,
  lang: 'en',
  answer: 25,
  sprite_url: '/api/pokedex/images/artwork/25.png',
  choices: [
    { dex_id: 1, name: 'Bulbasaur' },
    { dex_id: 25, name: 'Pikachu' },
    { dex_id: 4, name: 'Charmander' },
    { dex_id: 7, name: 'Squirtle' },
  ],
})

const summaryFor = (date, state) => ({
  date,
  streak: { current: 12, best: 12, freeze_available: true, active_today: true },
  quests: [
    { id: 'view_pokemon', done: true },
    { id: 'play_wtp', done: state.answers.length > 0 },
    { id: 'add_card', done: false },
  ],
  xp: { xp: 120, level: 3, level_start: 87, next_level_at: 150 },
  pokemon: { dex_id: 133, owned_printings: 3, cheapest: null },
  wtp: { played: state.answers.length > 0, correct: state.answers.some(a => a.dex_id === 25) },
})

async function install(page, { showDaily = true, answerFails = false } = {}) {
  const state = { answers: [], answerFails, views: 0 }
  await page.addInitScript(({ user, show }) => {
    localStorage.setItem('token', 'today-test-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
    localStorage.setItem('pc.splash.enabled', '0')
    if (!show) localStorage.setItem('pc.progress.showDaily.v1', '0')
  }, { user: USER, show: showDaily })
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (!path.startsWith('/api/')) return route.continue()
    const date = url.searchParams.get('date') || today()
    if (path.startsWith('/api/pokedex/images/')) return route.fulfill({ body: PNG, contentType: 'image/png' })
    if (path === '/api/pokedex/splash') return route.fulfill({ json: entryFor(date) })
    if (path === '/api/pokedex/wtp') return route.fulfill({ json: puzzleFor(date) })
    if (path === '/api/progress/today') return route.fulfill({ json: summaryFor(today(), state) })
    if (path === '/api/progress/daily/view') {
      state.views += 1
      return route.fulfill({ json: summaryFor(today(), state) })
    }
    if (path === '/api/progress/wtp/answer') {
      if (state.answerFails) return route.fulfill({ status: 502, json: { detail: 'down' } })
      const body = request.postDataJSON()
      state.answers.push(body)
      return route.fulfill({ json: { correct: body.dex_id === 25, answer: 25, chosen: body.dex_id, today: summaryFor(today(), state) } })
    }
    if (path === '/api/progress/unlocks/unseen') return route.fulfill({ json: { unlocks: [] } })
    const responses = {
      '/api/auth/mode': { multi_user: false },
      '/api/auth/me': USER,
      '/api/settings/': { language: 'en', price_primary: 'trend', currency: 'EUR', tcgdex_sync_languages: 'en' },
      '/api/settings/tcgdex-filter-languages': ['en'],
      '/api/profile/': { feature_enabled: false, is_profile_public: false },
      '/api/dashboard/': { total_cards: 0, unique_cards: 0, owned_sets: 0, recent_additions: [], top_cards: [] },
      '/api/collection/': [],
      '/api/wishlist/': [],
      '/api/sets/': [],
      '/api/binders/': [],
    }
    return route.fulfill({ json: responses[path] ?? {} })
  })
  return state
}

test('the Today card shows the streak, three quests, the level and what you own', async ({ page }) => {
  const state = await install(page)
  await page.goto('/')

  const card = page.getByTestId('today-card')
  await expect(card).toBeVisible()
  await expect(page.getByTestId('streak-chip')).toHaveAttribute('data-streak', '12')
  await expect(page.getByTestId('level-row')).toContainText('Level 3')
  await expect(page.getByTestId('pokemon-owned')).toHaveText('You own 3 printings')
  await expect(card.locator('[data-testid^="quest-"]')).toHaveCount(3)
  await expect(page.getByTestId('quest-view_pokemon')).toHaveAttribute('data-done', 'true')
  await expect(page.getByTestId('quest-add_card')).toHaveAttribute('data-done', 'false')
  await expect.poll(() => state.views).toBeGreaterThan(0)

  // The shortcuts row sits directly under the greeting, above the Today card.
  const shortcuts = page.getByRole('link', { name: 'Wishlist' }).first()
  const shortcutsBox = await shortcuts.boundingBox()
  const cardBox = await card.boundingBox()
  expect(shortcutsBox.y).toBeLessThan(cardBox.y)
})

test('Who\'s That Pokémon: a silhouette, four choices, one try, then the reveal and the share text', async ({ page, context }) => {
  const state = await install(page)
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
  await page.goto('/')

  await page.getByRole('button', { name: 'Play' }).click()
  const image = page.getByTestId('wtp-image')
  await expect(image).toHaveAttribute('data-revealed', 'false')
  await expect(page.getByRole('group', { name: 'Choices' }).getByRole('button')).toHaveCount(4)

  await page.getByTestId('wtp-choice-25').click()
  await expect(page.getByTestId('wtp-result')).toContainText("It's Pikachu")
  await expect(image).toHaveAttribute('data-revealed', 'true')
  await expect(page.getByTestId('wtp-choice-4')).toBeDisabled()
  expect(state.answers).toEqual([{ date: today(), dex_id: 25 }])

  // One try: a reload does not offer the puzzle again.
  await page.reload()
  await expect(page.getByTestId('wtp-tile')).toHaveAttribute('data-played', 'true')
  await expect(page.getByRole('button', { name: 'Play' })).toHaveCount(0)
})

test('an answer given while the server is unreachable is kept and sent when it is back', async ({ page }) => {
  const state = await install(page, { answerFails: true })
  await page.goto('/')
  await page.getByRole('button', { name: 'Play' }).click()
  await page.getByTestId('wtp-choice-7').click()
  await expect(page.getByTestId('wtp-result')).toContainText('It was Pikachu')
  await expect(page.getByText('Saved. It will be sent when you are back online.')).toBeVisible()
  expect(state.answers).toEqual([])

  state.answerFails = false
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(() => state.answers).toEqual([{ date: today(), dex_id: 7 }])
  await expect(page.getByText('Saved. It will be sent when you are back online.')).toHaveCount(0)
})

test('with "Show streaks and quests" off Home shows only the Pokémon of the day', async ({ page }) => {
  await install(page, { showDaily: false })
  await page.goto('/')
  await expect(page.getByTestId('pokemon-of-the-day')).toBeVisible()
  await expect(page.getByTestId('today-card')).toHaveCount(0)
  await expect(page.getByTestId('streak-chip')).toHaveCount(0)
  await expect(page.getByTestId('wtp-tile')).toHaveCount(0)
})
