import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// Weekly challenge fidelity (engagement P13b): renders the Wave 3 challenge artboards (S3HomeChallenge,
// S3Challenge, S3ChallengeResult, S3ChallengeBadge) with their sample data at 390 x 844. Ash is the viewer;
// Misty, Brock and Dawn are the other trainers. Every API is mocked. Runs in the Chromium "mobile" project
// and in "webkit-iphone". Each frame is also written to test-results/challenge-fidelity/<project>/ (not
// committed) to set beside the artboards. The measurements below are the artboards' own numbers.

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', '..', 'test-results', 'challenge-fidelity')

const ASH = { id: 1, username: 'Ash', role: 'admin', is_active: true, must_change_password: false, avatar_id: null }
const MISTY = { id: 2, username: 'Misty', avatar_id: null }
const BROCK = { id: 3, username: 'Brock', avatar_id: null }
const DAWN = { id: 4, username: 'Dawn', avatar_id: null }

// UK time: GMT from 25 October 2026, so a UK offset of +00:00 is also the device's time (the tests pin Europe/London).
const MID_WEEK = new Date('2026-10-30T14:00:00Z') // Friday 30 October, week 44
const MONDAY = new Date('2026-11-02T09:00:00Z') // Monday 2 November, week 45

const BINDERS = { id: 'binder_cards', title_key: 'challenge.binder_cards', target: 20, type: 'water' }
const WTP = { id: 'wtp_days', title_key: 'challenge.wtp_days', target: 3, type: 'psychic' }

const entry = (user, progress, finishedAt, place) => ({ user, progress, finished_at: finishedAt, place })
const BROCK_DONE = '2026-10-27T21:14:00+00:00' // Tuesday 21:14
const DAWN_DONE = '2026-10-29T19:02:00+00:00' // Thursday 19:02
const ASH_DONE = '2026-11-01T20:41:00+00:00' // Sunday 20:41

// The artboard shows third place open although Misty has 18: the sample is drawn before the owner's
// "highest count" rule, so the main frame leaves Misty's place unset. PROVISIONAL below is the same week with her third.
const BOARD = [
  entry(BROCK, 20, BROCK_DONE, 1),
  entry(DAWN, 20, DAWN_DONE, 2),
  entry(MISTY, 18, null, null),
  entry(ASH, 14, null, null),
]
const PROVISIONAL = BOARD.map(row => (row.user === MISTY ? { ...row, place: 3 } : row))

const midWeek = (board = BOARD) => ({
  week: '2026-W44', starts_at: '2026-10-26T00:00:00+00:00', ends_at: '2026-11-01T23:59:00+00:00', time_zone: 'Europe/London',
  challenge: BINDERS,
  me: { progress: 14, finished_at: null, place: null, on_board: true },
  board, finished_count: 2, trainer_count: 4, last: null,
})

const LAST = {
  week: '2026-W44', challenge: BINDERS,
  podium: [entry(BROCK, 20, BROCK_DONE, 1), entry(DAWN, 20, DAWN_DONE, 2), entry(ASH, 20, ASH_DONE, 3)],
  me: { progress: 20, finished_at: ASH_DONE, place: 3, on_board: true },
  finished_count: 3, trainer_count: 4, badge: { id: 'challenge_5', tier: 'silver' },
}
const monday = (last = LAST) => ({
  week: '2026-W45', starts_at: '2026-11-02T00:00:00+00:00', ends_at: '2026-11-08T23:59:00+00:00', time_zone: 'Europe/London',
  challenge: WTP,
  me: { progress: 0, finished_at: null, place: null, on_board: true },
  board: [entry(BROCK, 0, null, null), entry(DAWN, 0, null, null), entry(MISTY, 0, null, null), entry(ASH, 0, null, null)],
  finished_count: 0, trainer_count: 4, last,
})

const BADGE_UNLOCK = {
  id: 'challenge_5', name_key: 'achievements.challenge5', description_key: 'achievements.challenge5Desc',
  tier: 'silver', track: 'daily', art: 'trophy', badge_id: null, unlocked_at: '2026-11-02T00:06:00',
}

const stats = (user, i) => ({
  user_id: user.id, username: user.username, role: 'user', avatar_id: null, level: 10 - i, streak: 0, total_value: 100 * (4 - i),
  total_cards: 100, unique_cards: 90, sets_completed: 1, pnl: 0, most_valuable_card: null, showcase: [], public_handle: null,
})

const dayOf = date => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`

async function install(page, { now = MID_WEEK, challenge = midWeek(), social = true, hide = false, unlocks = [], log } = {}) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.setFixedTime(now)
  await page.addInitScript(({ account, hidden }) => {
    localStorage.setItem('token', 'challenge-test-token')
    localStorage.setItem('user', JSON.stringify(account))
    localStorage.setItem('app_language', 'en')
    localStorage.setItem('pc.splash.enabled', '0')
    if (hidden) localStorage.setItem('pc.hideValues', '1')
  }, { account: ASH, hidden: hide })
  const date = dayOf(now)
  const state = { challenge, calls: 0, unlocks }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/challenge') {
      state.calls += 1
      log?.push(path)
      if (!social) return route.fulfill({ status: 404, json: { detail: 'Not found' } })
      return route.fulfill({ json: state.challenge })
    }
    if (path.startsWith('/api/pokedex/images/') || path.startsWith('/api/images/')) return route.fulfill({ status: 404, body: '' })
    if (path === '/api/pokedex/splash') {
      return route.fulfill({ json: {
        date, dex_id: 133, name: 'Eevee', lang: 'en', generation: 1, region: 'Kanto', types: ['normal'], genus: 'Evolution Pokémon',
        height_m: 0.3, weight_kg: 6.5, shiny: false, facts: [], sprite_url: '/api/pokedex/images/showdown/133.gif', sprite_style: 'animated',
      } })
    }
    if (path === '/api/pokedex/wtp') {
      return route.fulfill({ json: {
        date, lang: 'en', answer: 25, sprite_url: '/api/pokedex/images/artwork/25.png',
        choices: [{ dex_id: 1, name: 'Bulbasaur' }, { dex_id: 25, name: 'Pikachu' }, { dex_id: 4, name: 'Charmander' }, { dex_id: 7, name: 'Squirtle' }],
      } })
    }
    if (path === '/api/progress/today') {
      return route.fulfill({ json: {
        date,
        streak: { current: 12, best: 12, freeze_available: false, active_today: true },
        quests: [{ id: 'review_scans', done: true }, { id: 'binder_card', done: true }, { id: 'play_wtp', done: false }],
        xp: { xp: 120, level: 3, level_start: 87, next_level_at: 150 },
        pokemon: { dex_id: 133, owned_printings: 0, cheapest: null, most_expensive: null },
        wtp: { played: false, correct: false },
      } })
    }
    if (path === '/api/progress/daily/view') return route.fulfill({ json: {} })
    if (path === '/api/progress/unlocks/unseen') return route.fulfill({ json: { unlocks: state.unlocks, quests: [] } })
    if (path === '/api/progress/unlocks/seen') {
      state.unlocks = []
      return route.fulfill({ json: { marked: 1 } })
    }
    if (path === '/api/social/leaderboard') return route.fulfill({ json: [ASH, MISTY, BROCK, DAWN].map(stats) })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/progress/recap/weekly') return route.fulfill({ json: { show: false, has_activity: false } })
    const responses = {
      '/api/auth/mode': { multi_user: true },
      '/api/auth/me': ASH,
      '/api/settings/': {
        language: 'en', price_primary: 'trend', currency: 'GBP', tcgdex_sync_languages: 'en',
        ...(social ? { social_features_enabled: 'true' } : {}),
      },
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

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map(img => (img.complete ? null : new Promise(r => { img.onload = img.onerror = r }))))
  })
  await page.waitForTimeout(250)
}

async function capture(page, testInfo, name) {
  await settle(page)
  const dir = join(OUT, testInfo.project.name)
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled' })
}

test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'Europe/London', locale: 'en-GB' })
test.beforeEach(({ browserName }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'The fidelity frames are phone-sized.')
  void browserName
})

const box = async locator => (await locator.first().boundingBox())
const near = (actual, expected, slack = 2) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(slack)

test('S3HomeChallenge: the challenge row sits in the Today card under the daily quests', async ({ page }, testInfo) => {
  await install(page)
  await page.goto('/')
  const row = page.getByTestId('challenge-today-row')
  await expect(row).toBeVisible()
  await expect(row.getByRole('heading', { name: 'Weekly challenge' })).toBeVisible()
  await expect(row).toContainText('2 days left')
  await expect(row).toContainText('Sort 20 cards into binders')
  await expect(row).toContainText('14 of 20')
  await expect(row).toContainText('Brock and Dawn finished')
  await expect(row.getByRole('progressbar', { name: 'Weekly challenge, 14 of 20' })).toHaveAttribute('aria-valuenow', '14')

  // It follows the daily quests and comes before Who's That Pokémon.
  const quests = await box(page.getByTestId('quests'))
  const mine = await box(row)
  const tile = await box(page.getByTestId('wtp-tile'))
  expect(mine.y).toBeGreaterThanOrEqual(quests.y + quests.height - 1)
  expect(tile.y).toBeGreaterThanOrEqual(mine.y + mine.height - 1)

  // The artboard's numbers: a 40 px circle, a 44 px link row, an 8 px bar 8 px under it, avatars of 20 px.
  const link = row.getByRole('link')
  expect((await box(link)).height).toBeGreaterThanOrEqual(44)
  near((await box(row.locator('span[aria-hidden="true"]').first())).width, 40, 0.5)
  const bar = await box(row.getByRole('progressbar'))
  near(bar.height, 8, 0.5)
  near(bar.y - ((await box(link)).y + (await box(link)).height), 8, 1)
  const avatars = row.getByTestId('challenge-finisher')
  near((await box(avatars.first())).width, 20, 0.5)
  near((await box(avatars.nth(1))).x - (await box(avatars.first())).x, 14, 0.5) // 20 px avatars overlapping by 6 px
  const barFill = await row.getByRole('progressbar').locator('div').first().boundingBox()
  near(barFill.width / bar.width, 0.7, 0.01)

  await row.evaluate(node => node.scrollIntoView({ block: 'center' }))
  await capture(page, testInfo, 'S3HomeChallenge')
})

test('S3HomeChallenge: finished shows the bar full and the place, and nobody else finished reads "Be the first"', async ({ page }) => {
  const done = midWeek([
    entry(BROCK, 20, BROCK_DONE, 1), entry(DAWN, 20, DAWN_DONE, 2), entry(ASH, 20, '2026-10-30T09:00:00+00:00', 3), entry(MISTY, 18, null, null),
  ])
  done.me = { progress: 20, finished_at: '2026-10-30T09:00:00+00:00', place: 3, on_board: true }
  await install(page, { challenge: done })
  await page.goto('/')
  const row = page.getByTestId('challenge-today-row')
  await expect(row).toContainText('Finished · 3rd')
  await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '20')
  await expect(row.getByRole('link')).toHaveAccessibleName(/Finished · 3rd/)
})

test('S3HomeChallenge: with nobody finished it says "Be the first to finish"', async ({ page }) => {
  await install(page, { challenge: midWeek([entry(MISTY, 18, null, null), entry(ASH, 14, null, null), entry(BROCK, 3, null, null)]) })
  await page.goto('/')
  await expect(page.getByTestId('challenge-today-row')).toContainText('Be the first to finish')
})

test('S3Challenge: the hero, the podium and the board mid-week', async ({ page }, testInfo) => {
  await install(page)
  await page.goto('/leaderboard/challenge')
  const group = page.getByRole('radiogroup', { name: 'Leaderboard' })
  await expect(group).toBeVisible()
  await expect(group.getByRole('radio')).toHaveCount(3)
  await expect(page.getByRole('radio', { name: 'Challenge' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('heading', { name: 'Sort 20 cards into binders', level: 1 })).toBeVisible()

  const hero = page.getByTestId('challenge-hero')
  await expect(hero).toContainText('Week 44 · ends Sunday 23:59 · 2 days left')
  await expect(hero).toContainText('14')
  await expect(hero).toContainText('/ 20')
  await expect(hero).toContainText('6 more to finish')
  await expect(hero.getByRole('progressbar', { name: 'Your progress, 14 of 20' })).toHaveAttribute('aria-valuenow', '14')

  // Hero: 22 px radius, 16 px padding, 358 wide, 144 high, right under the 36 px control and 16 px gap.
  const control = await box(group)
  const heroBox = await box(hero)
  near(control.height, 36, 1)
  near(heroBox.x, 16, 0.5)
  near(heroBox.width, 358, 0.5)
  near(heroBox.height, 144, 2)
  near(heroBox.y - (control.y + control.height), 16, 1)
  const heroBar = await box(hero.getByRole('progressbar'))
  near(heroBar.height, 8, 0.5)
  near((await hero.getByRole('progressbar').locator('div').first().boundingBox()).width / heroBar.width, 0.7, 0.01)

  // Podium: 2nd, 1st, 3rd with blocks of 56, 72 and 44; third is open.
  const podium = page.getByRole('list', { name: 'Podium' })
  await expect(page.getByRole('heading', { name: 'Podium' })).toBeVisible()
  await expect(page.getByText('Highest count by Sunday')).toBeVisible()
  await expect(podium.getByRole('listitem')).toHaveCount(3)
  const first = podium.locator('[data-place="1"]')
  const second = podium.locator('[data-place="2"]')
  const third = podium.locator('[data-place="3"]')
  await expect(first).toHaveAccessibleName('1st, Brock, finished Tuesday 21:14')
  await expect(second).toHaveAccessibleName('2nd, Dawn, finished Thursday 19:02')
  await expect(third).toHaveAccessibleName('3rd place, open')
  await expect(first).toContainText('Tue 21:14')
  await expect(second).toContainText('Thu 19:02')
  await expect(third).toContainText('Open')
  const blocks = async item => (await box(item.locator('span[aria-hidden="true"]').last())).height
  near(await blocks(first), 72, 0.5)
  near(await blocks(second), 56, 0.5)
  near(await blocks(third), 44, 0.5)
  const [b1, b2, b3] = [await box(first), await box(second), await box(third)]
  expect(b2.x).toBeLessThan(b1.x)
  expect(b1.x).toBeLessThan(b3.x)
  near(b1.width, (358 - 16) / 3, 1)
  expect(await third.locator('span[aria-hidden="true"]').last().evaluate(node => getComputedStyle(node).borderTopStyle)).toBe('dashed')

  // Board: finishers first, your row lifted, 60 px rows, the hairline inset to 84 px.
  const rows = page.getByTestId('challenge-board-row')
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(0)).toHaveAccessibleName('1st, Brock, finished Tuesday 21:14, 20 of 20')
  await expect(rows.nth(1)).toHaveAccessibleName('2nd, Dawn, finished Thursday 19:02, 20 of 20')
  await expect(rows.nth(2)).toHaveAccessibleName('Misty, 18 of 20')
  await expect(rows.nth(3)).toHaveAccessibleName('You, 14 of 20')
  await expect(rows.nth(0)).toContainText('Finished Tue 21:14')
  await expect(rows.nth(2)).toContainText('18/20')
  await expect(rows.nth(3)).toContainText('You')
  for (let i = 0; i < 4; i += 1) near((await box(rows.nth(i))).height, 60, 1)
  expect(await rows.nth(3).evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(44, 44, 46)')
  expect(await rows.nth(0).evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
  await expect(page.getByTestId('challenge-footer')).toHaveText('Counts cards you add to a binder this week. Everyone who finishes earns the Weekly Challenger badge and 50 XP.')
  await expect(page.getByRole('heading', { name: 'Trainers' })).toBeVisible()

  await capture(page, testInfo, 'S3Challenge')
})

test('S3Challenge: with a trainer on the count but not finished, third place is hers and shows her count', async ({ page }, testInfo) => {
  await install(page, { challenge: midWeek(PROVISIONAL) })
  await page.goto('/leaderboard/challenge')
  const third = page.getByRole('list', { name: 'Podium' }).locator('[data-place="3"]')
  await expect(third).toHaveAccessibleName('3rd, Misty, 18 of 20')
  await expect(third).toContainText('18 of 20')
  await expect(page.getByTestId('challenge-board-row').nth(2)).toHaveAccessibleName('3rd, Misty, 18 of 20')
  await capture(page, testInfo, 'S3Challenge-provisional')
})

test('S3ChallengeResult: Monday shows last week above the new one', async ({ page }, testInfo) => {
  await install(page, { now: MONDAY, challenge: monday() })
  await page.goto('/leaderboard/challenge')
  const result = page.getByTestId('challenge-result')
  await expect(result).toBeVisible()
  await expect(result).toContainText('Week 44 results')
  await expect(result.getByRole('heading', { name: 'Sort 20 cards into binders' })).toBeVisible()
  await expect(result).toContainText('3 of 4 trainers finished')
  await expect(result.getByTestId('challenge-result-line')).toHaveText('You finished 3rd · Sun 20:41')
  const podium = result.getByRole('list', { name: 'Podium' })
  await expect(podium.locator('[data-place="3"]')).toHaveAccessibleName('3rd, you, finished Sunday 20:41')
  await expect(podium.locator('[data-place="3"]')).toContainText('You')
  const badge = result.getByRole('link', { name: /Challenge Regular · Silver/ })
  await expect(badge).toContainText('5 challenges finished')
  await expect(badge).toHaveAttribute('href', '/achievements')

  const heroBox = await box(page.getByTestId('challenge-hero'))
  const resultBox = await box(result)
  near(resultBox.width, 358, 0.5)
  near(heroBox.y - (resultBox.y + resultBox.height), 16, 1)
  const blocks = async item => (await box(podium.locator(`[data-place="${item}"] span[aria-hidden="true"]`).last())).height
  near(await blocks(1), 104, 0.5)
  near(await blocks(2), 76, 0.5)
  near(await blocks(3), 56, 0.5)

  const hero = page.getByTestId('challenge-hero')
  await expect(hero).toContainText('This week · ends Sunday 23:59 · 6 days left')
  await expect(hero.getByRole('heading', { name: "Play Who's That Pokémon on 3 days" })).toBeVisible()
  await expect(hero).toContainText('3 more to finish')
  // Nobody has started yet: no empty podium or board under it.
  await expect(page.getByRole('heading', { name: 'Podium' })).toHaveCount(0)
  await expect(page.getByTestId('challenge-board')).toHaveCount(0)

  await capture(page, testInfo, 'S3ChallengeResult')
})

test('S3ChallengeResult: a trainer who did not finish reads their count, and no badge row without a new badge', async ({ page }) => {
  const last = { ...LAST, me: { progress: 14, finished_at: null, place: null, on_board: true }, badge: null, finished_count: 2 }
  await install(page, { now: MONDAY, challenge: monday(last) })
  await page.goto('/leaderboard/challenge')
  await expect(page.getByTestId('challenge-result-line')).toHaveText('You reached 14 of 20')
  await expect(page.getByTestId('challenge-result-badge')).toHaveCount(0)
})

test('S3ChallengeBadge: the finisher badge opens the unlock sheet with the trophy', async ({ page }, testInfo) => {
  await install(page, { now: MONDAY, challenge: monday(), unlocks: [BADGE_UNLOCK] })
  await page.goto('/leaderboard/challenge')
  const sheet = page.getByTestId('unlock-sheet')
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('heading', { name: 'Challenge Regular' })).toBeVisible()
  await expect(sheet).toContainText('Silver')
  await expect(sheet).toContainText('Finish 5 weekly challenges')
  const medal = sheet.getByRole('img', { name: 'Challenge Regular' })
  await expect(medal).toHaveAttribute('data-track', 'daily')
  const trophy = await medal.locator('g path').getAttribute('d')
  expect(trophy).toBe('M8 5h8v5a4 4 0 0 1-8 0z M8 7H6a2 2 0 0 0 0 4h2 M16 7h2a2 2 0 0 1 0 4h-2 M12 14v3 M9 19h6')
  const size = await box(medal)
  near(size.width, 132, 0.5)
  near(size.height, 143, 0.5)
  await capture(page, testInfo, 'S3ChallengeBadge')
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(sheet).toHaveCount(0)
})

test('with social off the challenge is gone: the route returns to the ranking and Home has no row', async ({ page }) => {
  const calls = []
  await install(page, { social: false, log: calls })
  await page.goto('/leaderboard/challenge')
  await expect(page).toHaveURL(/\/leaderboard$/)
  await expect(page.getByRole('radiogroup', { name: 'Leaderboard' })).toHaveCount(0)
  await page.goto('/')
  await expect(page.getByTestId('today-card')).toBeVisible()
  await expect(page.getByTestId('challenge-today-row')).toHaveCount(0)
  expect(calls).toEqual([])
})

test('hide values changes nothing here: the challenge shows counts, never amounts', async ({ page }) => {
  await install(page, { hide: true })
  await page.goto('/leaderboard/challenge')
  await expect(page.getByTestId('challenge-hero')).toContainText('14')
  await expect(page.getByTestId('challenge-board-row')).toHaveCount(4)
  await expect(page.locator('body')).not.toContainText('••••')
  await expect(page.locator('body')).not.toContainText('£')
})

test('offline: the last saved board stays, marked as saved', async ({ page }) => {
  await install(page)
  await page.goto('/leaderboard/challenge')
  await expect(page.getByTestId('challenge-hero')).toBeVisible()
  await expect(page.getByTestId('challenge-offline')).toHaveCount(0)
  // The server can't be reached: the next look keeps what was saved and says so.
  await page.route('**/api/challenge', route => route.abort('connectionrefused'))
  await page.getByRole('radio', { name: 'Ranking' }).click()
  await page.getByRole('radio', { name: 'Challenge' }).click()
  const note = page.getByTestId('challenge-offline')
  await expect(note).toBeVisible()
  await expect(note).toContainText('Offline. Showing the last saved board')
  await expect(page.getByTestId('challenge-hero')).toContainText('Sort 20 cards into binders')
  await expect(page.getByTestId('challenge-board-row')).toHaveCount(4)
})

test('the segments switch between Ranking, Activity and Challenge, and every target is 44 px', async ({ page }) => {
  await install(page)
  await page.goto('/leaderboard')
  await page.getByRole('radio', { name: 'Challenge' }).click()
  await expect(page).toHaveURL(/\/leaderboard\/challenge$/)
  await expect(page.getByTestId('challenge-hero')).toBeVisible()
  await page.getByRole('radio', { name: 'Ranking' }).click()
  await expect(page).toHaveURL(/\/leaderboard$/)
  await page.goto('/leaderboard/challenge')
  for (const radio of await page.getByRole('radio').all()) {
    expect((await box(radio)).height).toBeGreaterThanOrEqual(32) // the 36 px control: each segment is its full height
  }
})

test('Reduce Motion: the podium blocks rise once, and stand still under Reduce Motion', async ({ page }) => {
  await install(page, { challenge: midWeek(PROVISIONAL) })
  await page.goto('/leaderboard/challenge')
  const block = page.getByRole('list', { name: 'Podium' }).locator('[data-place="1"] span[aria-hidden="true"]').last()
  expect(await block.evaluate(node => getComputedStyle(node).animationName)).toBe('none')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  expect(await block.evaluate(node => getComputedStyle(node).animationName)).toBe('podium-rise')
})
