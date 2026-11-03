import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// Activity feed fidelity (engagement P12b): renders the Wave 3 feed artboards with their sample data
// (Ash is the viewer; Misty, Brock and Dawn are the other trainers), values shown and hidden, at
// 390 × 844. Runs in the Chromium "mobile" project and in "webkit-iphone". Each frame is also written
// to test-results/feed-fidelity/<project>/ (not committed) to set beside the artboards. The comments
// sheet has no artboard: it is designed in the same style.

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', '..', 'test-results', 'feed-fidelity')

const ASH = { id: 1, username: 'Ash', role: 'admin', is_active: true, must_change_password: false }
const NOW = new Date(2026, 9, 30, 14, 0) // Friday 30 October, 14:00

const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString()
const counts = (cheer = 0, wow = 0, fire = 0, heart = 0) => ({ cheer, wow, fire, heart })

const TRAINERS = {
  misty: { id: 2, username: 'Misty', avatar_id: null },
  brock: { id: 3, username: 'Brock', avatar_id: null },
  dawn: { id: 4, username: 'Dawn', avatar_id: null },
  ash: { id: 1, username: 'Ash', avatar_id: null },
}

const svgCard = (colours) => `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="100" viewBox="0 0 72 100"><rect width="72" height="100" fill="${colours[0]}"/><rect x="5" y="6" width="62" height="46" rx="3" fill="${colours[1]}"/><circle cx="36" cy="28" r="10" fill="none" stroke="#FFCB05" stroke-width="2"/></svg>`
const IMAGES = {
  umbreon: svgCard(['#141A24', '#2A3160']),
  mew: svgCard(['#551C78', '#F5C2E8']),
}

const FEED_FIRST = [
  {
    id: 9003, kind: 'set_completed', occurred_at: at(30, 12), trainer: TRAINERS.misty, mine: false,
    display: { set_key: 'sv08_en', set_name: 'Surging Sparks', lang: 'en', total: 191 },
    reactions: { counts: counts(2, 0, 1, 0), mine: ['cheer'] }, comment_count: 2,
  },
  {
    id: 9002, kind: 'big_pull', occurred_at: at(30, 9), trainer: TRAINERS.brock, mine: false,
    display: {
      card: { id: 'umbreon', name: 'Umbreon ex', number: '161', set_id: 'pre', lang: 'en', images_small: '/x' },
      variant: 'Holo', set_name: 'Prismatic Evolutions', amount: 182.4,
    },
    reactions: { counts: counts(1, 3, 2, 0), mine: ['wow', 'fire'] }, comment_count: 0,
  },
  {
    id: 9001, kind: 'achievement_unlocked', occurred_at: at(29, 20, 14), trainer: TRAINERS.dawn, mine: false,
    display: { achievement_id: 'pokedex_silver', name_key: 'achievements.kantoComplete', name: 'Kanto Complete', tier: 'silver', track: 'pokedex' },
    reactions: { counts: counts(1, 0, 0, 1), mine: ['heart'] }, comment_count: 0,
  },
]
const FEED_MORE = [
  {
    id: 8900, kind: 'goal_completed', occurred_at: at(29, 9, 12), trainer: TRAINERS.ash, mine: true,
    display: { goal_id: 7, goal_kind: 'family', title: 'All Eeveelutions' },
    reactions: { counts: counts(2, 0, 0, 1), mine: [] }, comment_count: 1,
  },
  {
    id: 8800, kind: 'challenge_finished', occurred_at: at(26, 0, 5), trainer: TRAINERS.brock, mine: false,
    display: { week: 43, challenge_id: 'wtp_days', title: "Play Who's That Pokémon on 5 days", place: 1 },
    reactions: { counts: counts(3, 0, 1, 0), mine: ['cheer'] }, comment_count: 0,
  },
  {
    id: 8700, kind: 'big_pull', occurred_at: at(26, 19, 40), trainer: TRAINERS.misty, mine: false,
    display: { card: { id: 'mew', name: 'Mew ex', number: '232', set_id: 'pfa', lang: 'en', images_small: '/x' }, variant: 'Holo', set_name: 'Paldean Fates' },
    reactions: { counts: counts(0, 2, 0, 0), mine: [] }, comment_count: 0,
  },
]

const LEADERBOARD = [
  { user_id: 2, username: 'Misty', role: 'user', avatar_id: null, level: 16, streak: 21, total_value: 1402.18, total_cards: 1820, unique_cards: 1200, sets_completed: 9, pnl: 212.4, most_valuable_card: null, showcase: [], public_handle: null },
  { user_id: 1, username: 'Ash', role: 'admin', avatar_id: null, level: 14, streak: 12, total_value: 1186.5, total_cards: 1204, unique_cards: 900, sets_completed: 6, pnl: 96.1, most_valuable_card: null, showcase: [], public_handle: null },
  { user_id: 4, username: 'Dawn', role: 'user', avatar_id: null, level: 11, streak: 5, total_value: 874.3, total_cards: 640, unique_cards: 500, sets_completed: 3, pnl: 40, most_valuable_card: null, showcase: [], public_handle: null },
  { user_id: 3, username: 'Brock', role: 'user', avatar_id: null, level: 9, streak: 0, total_value: 500, total_cards: 300, unique_cards: 250, sets_completed: 1, pnl: -12, most_valuable_card: null, showcase: [], public_handle: null },
]

const COMMENTS = [
  { id: 1, event_id: 9003, text: 'Congrats, that set is huge!', created_at: at(30, 12, 30), author: TRAINERS.brock, mine: false, can_delete: false },
  { id: 2, event_id: 9003, text: 'Thanks! The last card took forever.', created_at: at(30, 12, 40), author: TRAINERS.misty, mine: false, can_delete: false },
  { id: 3, event_id: 9003, text: 'Which one was it?', created_at: at(30, 13, 5), author: TRAINERS.ash, mine: true, can_delete: true },
]

const BASE_SETTINGS = {
  language: 'en', price_primary: 'trend', currency: 'GBP', tcgdex_sync_languages: 'en',
  social_features_enabled: 'true',
  feed_share_set_completed: 'true', feed_share_achievement_unlocked: 'true', feed_share_big_pull: 'false',
  feed_share_goal_completed: 'false', feed_share_values: 'false', feed_intro_seen: 'true',
}

async function install(page, { social = true, hideValues = false, intro = false, feed = 'full', settings = {}, offline = false } = {}) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.setFixedTime(NOW)
  await page.addInitScript(({ account, hide }) => {
    localStorage.setItem('token', 'feed-test-token')
    localStorage.setItem('user', JSON.stringify(account))
    localStorage.setItem('app_language', 'en')
    localStorage.setItem('pc.splash.enabled', '0')
    if (hide) localStorage.setItem('pc.hideValues', '1')
  }, { account: ASH, hide: hideValues })
  const state = { settings: { ...BASE_SETTINGS, social_features_enabled: social ? 'true' : 'false', feed_intro_seen: intro ? 'false' : 'true', ...settings }, comments: [...COMMENTS], puts: [], posts: [], feedCalls: [], eventCalls: [] }
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const method = route.request().method()
    if (!path.startsWith('/api/')) return route.continue()
    if (offline && path.startsWith('/api/feed')) return route.abort('connectionrefused')
    const card = path.match(/^\/api\/images\/card\/([^/]+)\//)
    if (card) return route.fulfill({ body: IMAGES[card[1]] || IMAGES.umbreon, contentType: 'image/svg+xml' })
    if (path.startsWith('/api/pokedex/images/') || path.startsWith('/api/images/')) return route.fulfill({ status: 404, body: '' })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/progress/unlocks/unseen') return route.fulfill({ json: { unlocks: [] } })
    if (path === '/api/progress/recap/weekly') return route.fulfill({ json: { show: false, has_activity: false } })
    if (path === '/api/social/leaderboard') return route.fulfill({ json: LEADERBOARD })
    if (path === '/api/feed' && method === 'GET') {
      state.feedCalls.push(url.search)
      if (feed === 'empty') return route.fulfill({ json: { items: [], next_before: null, reaction_kinds: ['cheer', 'wow', 'fire', 'heart'] } })
      const before = url.searchParams.get('before')
      return route.fulfill({
        json: before
          ? { items: FEED_MORE, next_before: null, reaction_kinds: ['cheer', 'wow', 'fire', 'heart'] }
          : { items: FEED_FIRST, next_before: 9001, reaction_kinds: ['cheer', 'wow', 'fire', 'heart'] },
      })
    }
    const single = path.match(/^\/api\/feed\/(\d+)$/)
    if (single && method === 'GET') {
      state.eventCalls.push(single[1])
      const row = [...FEED_FIRST, ...FEED_MORE].find(item => String(item.id) === single[1])
      return row ? route.fulfill({ json: row }) : route.fulfill({ status: 404, json: { detail: 'Not found' } })
    }
    const reaction = path.match(/^\/api\/feed\/(\d+)\/reactions\/(\w+)$/)
    if (reaction) {
      const item = [...FEED_FIRST, ...FEED_MORE].find(row => String(row.id) === reaction[1])
      const next = { counts: { ...item.reactions.counts }, mine: [...item.reactions.mine] }
      if (method === 'PUT') { next.counts[reaction[2]] += 1; next.mine.push(reaction[2]) } else { next.counts[reaction[2]] -= 1; next.mine = next.mine.filter(k => k !== reaction[2]) }
      return route.fulfill({ json: next })
    }
    const comments = path.match(/^\/api\/feed\/(\d+)\/comments(?:\/(\d+))?$/)
    if (comments) {
      if (method === 'GET') return route.fulfill({ json: { items: state.comments } })
      if (method === 'POST') {
        const body = route.request().postDataJSON()
        const created = { id: 99, event_id: Number(comments[1]), text: body.text.trim(), created_at: NOW.toISOString(), author: TRAINERS.ash, mine: true, can_delete: true }
        state.comments.push(created)
        state.posts.push(body.text)
        return route.fulfill({ status: 201, json: { comment: created, comment_count: state.comments.length } })
      }
      state.comments = state.comments.filter(c => String(c.id) !== comments[2])
      return route.fulfill({ json: { comment_count: state.comments.length } })
    }
    if (path === '/api/settings/' && method === 'PUT') {
      const updates = route.request().postDataJSON()
      state.puts.push(updates)
      Object.assign(state.settings, updates)
      return route.fulfill({ json: state.settings })
    }
    const responses = {
      '/api/auth/mode': { multi_user: true },
      '/api/auth/me': ASH,
      '/api/settings/': state.settings,
      '/api/settings/tcgdex-filter-languages': ['en'],
      '/api/profile/': { feature_enabled: false, is_profile_public: false },
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
  await page.waitForTimeout(200)
}

async function capture(page, testInfo, name) {
  const dir = join(OUT, testInfo.project.name)
  mkdirSync(dir, { recursive: true })
  await settle(page)
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled' })
  if (process.env.CI) await expect(page).toHaveScreenshot(`feed-${name}.png`, { animations: 'disabled' })
}

test.use({ viewport: { width: 390, height: 844 } })
test.beforeEach(({ browserName }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'The fidelity frames are phone-sized.')
  void browserName
})

const events = page => page.getByTestId('feed-event')

test('S3FeedRanking: the segments and the row that no longer overflows at 390 px', async ({ page }, testInfo) => {
  await install(page)
  await page.goto('/leaderboard')
  await expect(page.getByRole('radiogroup', { name: 'Leaderboard' })).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Ranking' })).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('radio', { name: 'Activity' })).toBeVisible()
  await expect(page.getByText('£1402.18').first()).toBeVisible()
  // Nothing in the first rows is wider than the screen: the value sits by the name, the chips below.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  const rank1 = page.getByRole('list', { name: 'Leaderboard' }).locator('li').first()
  const nameBox = await rank1.getByText('Misty', { exact: true }).boundingBox()
  const valueBox = await rank1.getByText('£1402.18').boundingBox()
  const levelBox = await rank1.getByTestId('leaderboard-level').boundingBox()
  expect(Math.abs(nameBox.y - valueBox.y)).toBeLessThan(6)
  expect(levelBox.y).toBeGreaterThan(nameBox.y + nameBox.height - 2)
  await expect(rank1).not.toContainText('admin')
  await capture(page, testInfo, '01-ranking')
})

test('S3LeaderboardOff: no segments while the switch is off, and the feed route goes back', async ({ page }, testInfo) => {
  await install(page, { social: false })
  await page.goto('/leaderboard')
  await expect(page.getByText('£1402.18').first()).toBeVisible()
  await expect(page.getByRole('radiogroup', { name: 'Leaderboard' })).toHaveCount(0)
  await capture(page, testInfo, '02-ranking-social-off')
  await page.goto('/leaderboard/activity')
  await expect(page).toHaveURL(/\/leaderboard$/)
  await expect(page.getByTestId('activity-feed')).toHaveCount(0)
})

test('S3Feed: a set, a big pull and a badge, with reactions, values shown', async ({ page }, testInfo) => {
  await install(page)
  await page.goto('/leaderboard')
  await page.getByRole('radio', { name: 'Activity' }).click()
  await expect(page).toHaveURL(/\/leaderboard\/activity$/)
  await expect(events(page)).toHaveCount(6)
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Yesterday' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'What you share' })).toBeVisible()
  await expect(events(page).nth(0)).toHaveAccessibleName('Misty completed a set, Surging Sparks. 2 hours ago')
  await expect(events(page).nth(1)).toContainText('£182.40')
  await expect(events(page).nth(1)).toContainText('Prismatic Evolutions · 161')
  await expect(events(page).nth(2)).toContainText('Silver · Pokédex')
  await expect(events(page).nth(2)).toContainText('Yesterday at 20:14')
  await expect(page.getByRole('button', { name: 'Cheer, 2, you reacted' })).toHaveAttribute('aria-pressed', 'true')
  await expect(events(page).nth(0).getByRole('button', { name: 'Fire, 1' })).toHaveAttribute('aria-pressed', 'false')
  await capture(page, testInfo, '03-feed')
})

test('S3Feed with hide-values: every amount is masked', async ({ page }, testInfo) => {
  await install(page, { hideValues: true })
  await page.goto('/leaderboard/activity')
  await expect(events(page)).toHaveCount(6)
  await expect(events(page).nth(1)).toContainText('••••')
  await expect(page.locator('body')).not.toContainText('182.40')
  await expect(events(page).nth(1)).not.toHaveAccessibleName(/182/)
  await capture(page, testInfo, '04-feed-hidden')
})

test('S3FeedMore: paging, your own goal with counts, a challenge finish and a pull without a value', async ({ page }, testInfo) => {
  const state = await install(page)
  await page.goto('/leaderboard/activity')
  await expect(events(page)).toHaveCount(6)
  expect(state.feedCalls.length).toBe(2)
  expect(state.feedCalls[1]).toContain('before=9001')
  const mine = events(page).nth(3)
  await expect(mine).toContainText('You')
  await expect(mine).toContainText('completed a goal')
  await expect(mine).toContainText('All Eeveelutions')
  // Your own event: counts, never buttons, and the screen reader hears the summary.
  await expect(mine.getByRole('button', { name: /Cheer|Love/ })).toHaveCount(0)
  await expect(mine).toHaveAccessibleName(/2 cheers, 1 love it/)
  await expect(events(page).nth(4)).toContainText('finished first in the weekly challenge')
  await expect(events(page).nth(5)).not.toContainText('£')
  await mine.scrollIntoViewIfNeeded()
  await page.evaluate(() => {
    const top = document.querySelectorAll('[data-testid="feed-event"]')[3].getBoundingClientRect().top
    window.scrollBy(0, top - 100)
  })
  await capture(page, testInfo, '05-feed-more')
})

test('a reaction toggles at once and keeps the server answer', async ({ page }) => {
  await install(page)
  await page.goto('/leaderboard/activity')
  const wow = events(page).nth(0).getByRole('button', { name: 'Wow' })
  await wow.click()
  await expect(events(page).nth(0).getByRole('button', { name: 'Wow, 1, you reacted' })).toHaveAttribute('aria-pressed', 'true')
  await events(page).nth(0).getByRole('button', { name: 'Wow, 1, you reacted' }).click()
  await expect(events(page).nth(0).getByRole('button', { name: 'Wow' })).toHaveAttribute('aria-pressed', 'false')
})

test('S3FeedEmpty: first visit card over the empty state', async ({ page }, testInfo) => {
  await install(page, { intro: true, feed: 'empty' })
  await page.goto('/leaderboard/activity')
  await expect(page.getByTestId('feed-intro')).toBeVisible()
  await expect(page.getByTestId('feed-empty')).toBeVisible()
  await expect(page.getByText('Nothing here yet')).toBeVisible()
  await capture(page, testInfo, '06-feed-empty')
})

test('the first-visit card is dismissed with OK and stays gone', async ({ page }) => {
  const state = await install(page, { intro: true })
  await page.goto('/leaderboard/activity')
  await page.getByTestId('feed-intro').getByRole('button', { name: 'OK' }).click()
  await expect(page.getByTestId('feed-intro')).toHaveCount(0)
  expect(state.puts).toContainEqual({ feed_intro_seen: 'true' })
})

test('S3FeedSharing: the sheet saves each switch at once', async ({ page }, testInfo) => {
  const state = await install(page, { intro: true, feed: 'empty' })
  await page.goto('/leaderboard/activity')
  await page.getByTestId('feed-intro').getByRole('button', { name: 'Change' }).click()
  const sheet = page.getByRole('dialog', { name: 'What you share' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('switch', { name: 'Sets you complete' })).toHaveAttribute('aria-checked', 'true')
  await expect(sheet.getByRole('switch', { name: 'Big pulls' })).toHaveAttribute('aria-checked', 'false')
  await expect(sheet.getByText('Cards worth £20.00 or more when you add them')).toBeVisible()
  await expect(sheet.getByText('Only the trainers on this server see your activity.', { exact: false })).toBeVisible()
  await capture(page, testInfo, '07-sharing')
  await sheet.getByRole('switch', { name: 'Big pulls' }).click()
  await expect(sheet.getByRole('switch', { name: 'Big pulls' })).toHaveAttribute('aria-checked', 'true')
  expect(state.puts).toContainEqual({ feed_share_big_pull: 'true' })
  await sheet.getByRole('button', { name: 'Done' }).click()
  await expect(sheet).toHaveCount(0)
})

test('offline: the feed says it needs a connection', async ({ page }, testInfo) => {
  await install(page, { offline: true })
  await page.goto('/leaderboard/activity')
  await expect(page.getByTestId('feed-offline')).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('The activity feed needs a connection.')).toBeVisible()
  await capture(page, testInfo, '08-feed-offline')
})

test('comments: read, write and delete under an event', async ({ page }, testInfo) => {
  const state = await install(page)
  await page.goto('/leaderboard/activity')
  await page.evaluate(() => {
    const target = new EventTarget()
    const viewport = Object.assign(target, { height: window.innerHeight, offsetTop: 0, width: window.innerWidth })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    window.__fakeViewport = viewport
  })
  await events(page).nth(0).getByTestId('feed-comments').click()
  const sheet = page.getByRole('dialog', { name: 'Comments' })
  await expect(sheet.getByTestId('feed-comment')).toHaveCount(3)
  await expect(sheet.getByText('Congrats, that set is huge!')).toBeVisible()
  // Only your own comment carries a delete button here (you do not own this event).
  await expect(sheet.getByRole('button', { name: 'Delete comment' })).toHaveCount(1)
  await capture(page, testInfo, '09-comments')
  // Nothing of the page shows through the sheet: it is a solid card above the tab bar.
  expect(await sheet.evaluate(node => getComputedStyle(node).backgroundColor)).toBe('rgb(28, 28, 30)')
  // With the keyboard open (a 300 px visual viewport cut) the composer stays above it, on the same solid sheet.
  await sheet.getByRole('textbox', { name: 'Add a comment' }).focus()
  await page.evaluate(() => {
    window.__fakeViewport.height = window.innerHeight - 300
    window.__fakeViewport.dispatchEvent(new Event('resize'))
  })
  await expect.poll(async () => {
    const box = await sheet.boundingBox()
    return Math.round(844 - (box.y + box.height))
  }).toBe(300)
  await expect(sheet.getByRole('textbox', { name: 'Add a comment' })).toBeInViewport()
  await capture(page, testInfo, '10-comments-keyboard')
  await page.evaluate(() => {
    window.__fakeViewport.height = window.innerHeight
    window.__fakeViewport.dispatchEvent(new Event('resize'))
  })
  const send = sheet.getByRole('button', { name: 'Send comment' })
  await expect(send).toBeDisabled()
  await sheet.getByRole('textbox', { name: 'Add a comment' }).fill('  Well played  ')
  await send.click()
  await expect(sheet.getByTestId('feed-comment')).toHaveCount(4)
  expect(state.posts).toEqual(['Well played'])
  await sheet.getByRole('button', { name: 'Delete comment' }).last().click()
  await page.getByRole('dialog', { name: 'Delete this comment?' }).getByRole('button', { name: 'Delete' }).click()
  await expect(sheet.getByTestId('feed-comment')).toHaveCount(3)
  await sheet.getByRole('button', { name: 'Done' }).click()
  await expect(events(page).nth(0).getByTestId('feed-comments')).toHaveAccessibleName('Comments, 3')
})

test('targets are 44 px and nothing scrolls sideways', async ({ page }) => {
  await install(page)
  await page.goto('/leaderboard/activity')
  await expect(events(page)).toHaveCount(6)
  const small = await page.evaluate(() => [...document.querySelectorAll('[data-testid="activity-feed"] button, [data-testid="activity-feed"] a')]
    .map(node => ({ name: node.getAttribute('aria-label') || node.textContent.trim(), rect: node.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width > 0 && (rect.height < 43.5 || rect.width < 43.5))
    .map(({ name, rect }) => `${name} ${Math.round(rect.width)}x${Math.round(rect.height)}`))
  expect(small).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
})

// Reaction and comment pushes open the feed at their event (docs/SOCIAL_DESIGN.md §6.7).
test('a reaction link opens the feed at that event and then drops the query', async ({ page }) => {
  await install(page)
  await page.goto('/leaderboard/activity?event=9002')
  await expect(events(page)).toHaveCount(3)
  await expect(page.locator('[data-event-id="9002"]')).toBeInViewport()
  await expect(page.getByRole('dialog', { name: 'Comments' })).toHaveCount(0)
  await expect.poll(() => new URL(page.url()).search).toBe('')
})

test('a comment link opens the feed with that event's comments sheet', async ({ page }) => {
  await install(page)
  await page.goto('/leaderboard/activity?event=9003&comments=1')
  const sheet = page.getByRole('dialog', { name: 'Comments' })
  await expect(sheet.getByTestId('feed-comment')).toHaveCount(3)
  await expect.poll(() => new URL(page.url()).search).toBe('')
})

test('a link to an event beyond the loaded page pins it on top; an unknown one just shows the feed', async ({ page }) => {
  const state = await install(page)
  await page.goto('/leaderboard/activity?event=8700')
  await expect(page.locator('[data-event-id="8700"]')).toBeVisible()
  expect(state.eventCalls).toContain('8700')
  await page.goto('/leaderboard/activity?event=1')
  await expect(events(page)).toHaveCount(3)
  await expect(page.getByRole('alert')).toHaveCount(0)
})
