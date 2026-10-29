import { expect, test } from '@playwright/test'

// Badge unlock sheet and the Achievements page in single-user mode (engagement P6). Runs on desktop
// and mobile Chromium, and on iPhone WebKit through playwright.webkit.config.js.

const USER = { id: 1, username: 'Badge Reviewer', role: 'admin', is_active: true, must_change_password: false }

const UNLOCKS = [
  { id: 'first_holo', name_key: 'achievements.firstHolo', description_key: 'achievements.firstHoloDesc', tier: 'bronze', track: 'variety', art: 'holo', unlocked_at: '2026-10-28T10:00:00' },
  { id: 'dex_10', name_key: 'achievements.dex10', description_key: 'achievements.dex10Desc', tier: 'bronze', track: 'pokedex', art: 'dex', unlocked_at: '2026-10-28T10:01:00' },
]

const ACHIEVEMENTS = {
  user_id: 1,
  username: USER.username,
  earned: 2,
  total: 3,
  achievements: [
    { id: 'first_card', name_key: 'achievements.firstCard', description_key: 'achievements.firstCardDesc', badge_id: 1, tier: 'bronze', track: 'collection', unlocked: true, unlocked_at: '2026-10-20T09:00:00', seen_at: '2026-10-20T09:00:00', progress: 1, target: 1 },
    { id: 'dex_50', name_key: 'achievements.dex50', description_key: 'achievements.dex50Desc', badge_id: null, tier: 'bronze', track: 'pokedex', unlocked: false, unlocked_at: null, seen_at: null, progress: 12, target: 50 },
    { id: 'first_holo', name_key: 'achievements.firstHolo', description_key: 'achievements.firstHoloDesc', badge_id: null, tier: 'bronze', track: 'variety', unlocked: true, unlocked_at: '2026-10-28T10:00:00', seen_at: null, progress: 1, target: 1 },
  ],
  tracks: [
    { track: 'collection', earned: 1, total: 1, tier: 'bronze' },
    { track: 'pokedex', earned: 0, total: 1, tier: null },
    { track: 'variety', earned: 1, total: 1, tier: 'bronze' },
  ],
}

async function install(page, { reducedMotion = false } = {}) {
  const state = { unseen: [...UNLOCKS], seenPosts: [] }
  if (reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript((user) => {
    localStorage.setItem('token', 'unlock-test-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
  }, USER)
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/progress/unlocks/unseen') return route.fulfill({ json: { unlocks: state.unseen } })
    if (path === '/api/progress/unlocks/seen') {
      const body = request.postDataJSON()
      state.seenPosts.push(body)
      state.unseen = state.unseen.filter(item => !body.ids.includes(item.id))
      return route.fulfill({ json: { marked: body.ids.length } })
    }
    const responses = {
      '/api/auth/mode': { multi_user: false },
      '/api/auth/me': USER,
      '/api/settings/': { language: 'en', price_primary: 'trend', currency: 'EUR', tcgdex_sync_languages: 'en' },
      '/api/settings/tcgdex-filter-languages': ['en'],
      '/api/profile/': { feature_enabled: false, is_profile_public: false },
      '/api/social/achievements/1': ACHIEVEMENTS,
      '/api/collection/': [],
      '/api/wishlist/': [],
      '/api/sets/': [],
      '/api/binders/': [],
    }
    return route.fulfill({ json: responses[path] ?? {} })
  })
  return state
}

test('an unlock sheet appears once, queues the next badge and marks each seen', async ({ page }) => {
  const state = await install(page)
  await page.goto('/collection')

  const sheet = page.getByTestId('unlock-sheet')
  await expect(sheet).toBeVisible()
  await expect(sheet).toHaveAttribute('data-achievement-id', 'first_holo')
  await expect(sheet).toContainText('First Shine')
  await expect(page.getByTestId('unlock-more')).toContainText('1 more')

  await page.getByRole('button', { name: 'Next badge' }).click()
  await expect(sheet).toHaveAttribute('data-achievement-id', 'dex_10')
  await expect(page.getByTestId('unlock-more')).toHaveCount(0)

  await page.getByRole('button', { name: 'Done' }).click()
  await expect(sheet).toHaveCount(0)
  expect(state.seenPosts).toEqual([{ ids: ['first_holo'] }, { ids: ['dex_10'] }])

  // Coming back to the app asks again; nothing is left, so no sheet.
  await page.reload()
  await expect(page.getByRole('heading', { name: /Collection/ }).first()).toBeVisible()
  await expect(page.getByTestId('unlock-sheet')).toHaveCount(0)
})

test('with Reduce Motion the sheet has no animation', async ({ page }) => {
  await install(page, { reducedMotion: true })
  await page.goto('/collection')
  const sheet = page.getByTestId('unlock-sheet')
  await expect(sheet).toBeVisible()
  const animations = await page.getByRole('dialog').evaluate(el => getComputedStyle(el).animationName)
  expect(animations).toBe('none')
})

test('the Achievements page works in single-user mode, grouped by track', async ({ page }) => {
  const state = await install(page)
  state.unseen = []
  await page.goto('/achievements')
  await expect(page).toHaveURL(/\/achievements$/)
  await expect(page.getByTestId('track-collection')).toBeVisible()
  await expect(page.getByTestId('track-pokedex')).toContainText('Species Seeker 50')
  await expect(page.getByTestId('achievement-dex_50').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '12')
  await expect(page.getByTestId('achievement-first_card')).toContainText('Earned')
})
