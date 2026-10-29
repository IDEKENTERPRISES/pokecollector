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

const PRICIEST = {
  card_id: 'sv8pt5-075_en', name: 'Eevee', set_name: 'Prismatic Evolutions', number: '075', lang: 'en', price: 41.26,
}

const summaryFor = (date, state) => ({
  date,
  streak: { current: state.streak, best: 12, freeze_available: true, active_today: true },
  quests: [
    { id: 'view_pokemon', done: true },
    { id: 'play_wtp', done: state.answers.length > 0 },
    { id: 'add_card', done: false },
  ],
  xp: { xp: 120, level: 3, level_start: 87, next_level_at: 150 },
  pokemon: { dex_id: 133, owned_printings: 3, cheapest: null, most_expensive: PRICIEST },
  wtp: { played: state.answers.length > 0, correct: state.answers.some(a => a.dex_id === 25) },
})

async function install(page, { showDaily = true, answerFails = false, streak = 12, quests = [], share = 'files' } = {}) {
  const state = { answers: [], answerFails, views: 0, streak, quests, seen: [], refused: 0 }
  await page.addInitScript(({ user, show, shareMode }) => {
    localStorage.setItem('token', 'today-test-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
    localStorage.setItem('pc.splash.enabled', '0')
    if (!show) localStorage.setItem('pc.progress.showDaily.v1', '0')
    // The share sheet itself cannot be driven in a test: record what the page hands to it.
    window.__shared = []
    if (shareMode === 'files' || shareMode === 'text') {
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: data => shareMode === 'files' && Boolean(data?.files?.length) })
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data) => {
          const file = data.files?.[0]
          const bytes = file ? new Uint8Array(await file.arrayBuffer()) : null
          const view = bytes && new DataView(bytes.buffer)
          window.__shared.push({
            text: data.text ?? null,
            name: file?.name ?? null,
            type: file?.type ?? null,
            size: bytes?.length ?? 0,
            png: bytes ? Array.from(bytes.slice(0, 4)) : null,
            width: view ? view.getUint32(16) : null,
            height: view ? view.getUint32(20) : null,
          })
        },
      })
    } else {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined })
    }
  }, { user: USER, show: showDaily, shareMode: share })
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
      if (state.answerFails) {
        state.refused += 1
        return route.fulfill({ status: 502, json: { detail: 'down' } })
      }
      const body = request.postDataJSON()
      state.answers.push(body)
      return route.fulfill({ json: { correct: body.dex_id === 25, answer: 25, chosen: body.dex_id, today: summaryFor(today(), state) } })
    }
    if (path === '/api/progress/unlocks/unseen') return route.fulfill({ json: { unlocks: [], quests: state.quests } })
    if (path === '/api/progress/unlocks/seen') {
      const body = request.postDataJSON()
      state.seen.push(body)
      state.quests = state.quests.filter(quest => !(body.quest_keys ?? []).includes(quest.key))
      return route.fulfill({ json: { marked: 0, quests_marked: (body.quest_keys ?? []).length } })
    }
    if (path === '/api/achievements' || path.startsWith('/api/social/achievements/')) {
      return route.fulfill({ json: { earned: 0, total: 20, achievements: [], tracks: [] } })
    }
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

  // The refused send must have finished: an online event during a running send is ignored by design.
  await expect.poll(() => state.refused).toBeGreaterThan(0)
  await page.waitForTimeout(300)
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

test('the Pokémon of the day also shows its most expensive print and links to it', async ({ page }) => {
  await install(page)
  await page.goto('/')
  const priciest = page.getByTestId('pokemon-priciest')
  await expect(priciest).toContainText('Most expensive print')
  await expect(priciest).toContainText(/41[.,]26/)
  await expect(priciest).toHaveAttribute('href', '/pokedex/133?sort=price_desc')
  await expect(page.getByTestId('pokemon-priciest-card')).toHaveText('Eevee · Prismatic Evolutions 075')
  // It sits beside the ownership line, not instead of it.
  await expect(page.getByTestId('pokemon-owned')).toBeVisible()
})

test('tapping the most expensive print\'s name opens that card, owned or not', async ({ page }) => {
  await install(page)
  await page.route('**/api/cards/sv8pt5-075_en', route => route.fulfill({
    json: {
      id: 'sv8pt5-075_en', name: 'Eevee', set_id: 'sv8pt5', set_name: 'Prismatic Evolutions', number: '075', lang: 'en', price_market: 41.26,
    },
  }))
  await page.goto('/')
  const open = page.getByRole('button', { name: 'Open card: Eevee · Prismatic Evolutions 075' })
  const box = await open.boundingBox()
  expect(box.height).toBeGreaterThanOrEqual(44)
  await open.click()
  await expect(page.getByRole('heading', { name: 'Eevee' }).last()).toBeVisible()
  await expect(page.getByText('Prismatic Evolutions').last()).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
})

test('a failed card load shows a toast and opens nothing', async ({ page }) => {
  await install(page)
  await page.route('**/api/cards/sv8pt5-075_en', route => route.fulfill({ status: 500, json: { detail: 'down' } }))
  await page.goto('/')
  await page.getByTestId('pokemon-priciest-card').click()
  await expect(page.getByText("Couldn't open that card")).toBeVisible()
})

test('the streak sits next to the greeting and brings the Today card into view', async ({ page }) => {
  await install(page)
  await page.goto('/')
  const chip = page.getByTestId('greeting-streak')
  await expect(chip).toBeVisible()
  await expect(chip).toHaveAttribute('data-streak', '12')
  await expect(chip).toHaveAccessibleName(/12-day streak/)

  const hello = await page.getByText('Hello,').first().boundingBox()
  const box = await chip.boundingBox()
  expect(Math.abs((box.y + box.height / 2) - (hello.y + hello.height))).toBeLessThan(60)
  expect(box.x).toBeGreaterThan(hello.x)

  // Tapping it scrolls the Today card into view (a short desktop page may already show it).
  await page.evaluate(() => {
    const original = Element.prototype.scrollIntoView
    window.__scrolledTo = []
    Element.prototype.scrollIntoView = function scrollIntoView(...args) {
      window.__scrolledTo.push(this.id)
      return original.apply(this, args)
    }
  })
  await chip.click()
  await expect.poll(() => page.evaluate(() => window.__scrolledTo)).toEqual(['today-card'])
  const card = await page.getByTestId('today-card').boundingBox()
  const viewport = page.viewportSize()
  expect(card.y).toBeLessThan(viewport.height - 100)
})

test('the greeting streak is hidden at a streak of 0', async ({ page }) => {
  await install(page, { streak: 0 })
  await page.goto('/')
  await expect(page.getByTestId('today-card')).toBeVisible()
  await expect(page.getByTestId('greeting-streak')).toHaveCount(0)
})

test('with "Show streaks and quests" off there is no streak beside the greeting', async ({ page }) => {
  await install(page, { showDaily: false })
  await page.goto('/')
  await expect(page.getByTestId('pokemon-of-the-day')).toBeVisible()
  await expect(page.getByTestId('greeting-streak')).toHaveCount(0)
})

test('a completed quest gets a sheet naming it and the XP, once, one after another', async ({ page }) => {
  const day = today()
  const state = await install(page, {
    quests: [
      { key: `${day}:add_card`, date: day, quest_id: 'add_card', xp: 10, bonus_xp: 0, completed_at: `${day}T08:00:00` },
      { key: `${day}:play_wtp`, date: day, quest_id: 'play_wtp', xp: 10, bonus_xp: 15, completed_at: `${day}T09:00:00` },
    ],
  })
  await page.goto('/')

  const sheet = page.getByTestId('quest-sheet')
  await expect(sheet).toBeVisible()
  await expect(sheet).toHaveAttribute('data-quest-id', 'add_card')
  await expect(page.getByTestId('quest-sheet-name')).toHaveText('Add a card to your collection')
  await expect(page.getByTestId('quest-sheet-xp')).toHaveText('+10 XP')
  await expect(page.getByTestId('quest-sheet-bonus')).toHaveCount(0)
  await expect(page.getByTestId('unlock-more')).toContainText('1 more')

  await page.getByRole('button', { name: 'Next' }).click()
  await expect(sheet).toHaveAttribute('data-quest-id', 'play_wtp')
  await expect(page.getByTestId('quest-sheet-name')).toHaveText("Play Who's That Pokémon")
  await expect(page.getByTestId('quest-sheet-bonus')).toContainText('+15 XP bonus')

  await page.getByRole('button', { name: 'Done' }).click()
  await expect(sheet).toHaveCount(0)
  expect(state.seen).toEqual([{ quest_keys: [`${day}:add_card`] }, { quest_keys: [`${day}:play_wtp`] }])

  // Once per quest: coming back to the app does not bring them back.
  await page.reload()
  await expect(page.getByTestId('today-card')).toBeVisible()
  await expect(page.getByTestId('quest-sheet')).toHaveCount(0)
})

test('Share opens a choice of text or picture, and the picture is a 1080 by 1920 PNG', async ({ page }) => {
  await install(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Play' }).click()
  await page.getByTestId('wtp-choice-25').click()
  await expect(page.getByTestId('wtp-result')).toBeVisible()

  await page.getByTestId('wtp-share').click()
  const choice = page.getByRole('dialog', { name: 'Share your result' })
  await expect(choice.getByRole('button', { name: 'Share as text' })).toBeVisible()
  await expect(choice.getByRole('button', { name: 'Share as picture' })).toBeVisible()

  await choice.getByRole('button', { name: 'Share as text' }).click()
  await expect.poll(() => page.evaluate(() => window.__shared.length)).toBe(1)
  const text = await page.evaluate(() => window.__shared[0])
  expect(text.text).toContain('🔥 12-day streak')
  expect(text.name).toBeNull()

  await page.getByTestId('wtp-share').click()
  await page.getByRole('dialog', { name: 'Share your result' }).getByRole('button', { name: 'Share as picture' }).click()
  await expect.poll(() => page.evaluate(() => window.__shared.length)).toBe(2)
  const picture = await page.evaluate(() => window.__shared[1])
  expect(picture).toMatchObject({ name: 'whos-that-pokemon.png', type: 'image/png', width: 1080, height: 1920 })
  expect(picture.png).toEqual([0x89, 0x50, 0x4e, 0x47])
  expect(picture.size).toBeGreaterThan(5000)
})

test('Share as picture downloads the PNG when the device cannot share files', async ({ page }) => {
  await install(page, { share: 'none' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Play' }).click()
  await page.getByTestId('wtp-choice-7').click()
  await expect(page.getByTestId('wtp-result')).toBeVisible()
  await page.getByTestId('wtp-share').click()
  const download = page.waitForEvent('download')
  await page.getByRole('dialog', { name: 'Share your result' }).getByRole('button', { name: 'Share as picture' }).click()
  expect((await download).suggestedFilename()).toBe('whos-that-pokemon.png')
})

test('Profile shows the XP bar toward the next level on the trainer card, without motion when asked', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await install(page)
  await page.goto('/profile')

  const bar = page.getByTestId('trainer-xp-bar')
  await expect(bar).toBeVisible()
  await expect(bar).toHaveAttribute('data-level', '3')
  await expect(bar).toHaveAttribute('data-percent', '52')
  await expect(bar).toContainText('Level 3')
  await expect(bar).toContainText('33 / 63 XP')
  await expect(bar).toContainText('30 XP to level 4')
  const progress = bar.getByRole('progressbar')
  await expect(progress).toHaveAttribute('aria-valuenow', '33')
  await expect(progress).toHaveAttribute('aria-valuemax', '63')
  // Reduce Motion: the fill is at its width straight away and nothing transitions.
  await expect(page.getByTestId('trainer-xp-bar-fill')).not.toHaveCSS('width', '0px')
  await expect(page.getByTestId('trainer-xp-bar-fill')).toHaveCSS('transition-duration', '0s')
})
