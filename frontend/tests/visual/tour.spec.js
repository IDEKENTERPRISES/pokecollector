import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// The hands-on tour (engagement P15, docs/WELCOME_DESIGN.md §3): the whole walk by really tapping the highlighted
// controls, in a mocked API. Runs in Chromium ("mobile") and in "webkit-iphone", both at 390 x 844. The first test
// also writes one PNG per step to test-results/tour-fidelity/<project>/ (not committed) to set beside the Wave 4 artboards.

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', '..', 'test-results', 'tour-fidelity')

const NEW_ACCOUNT = '2026-11-03T08:00:00'
const OLD_ACCOUNT = '2026-10-01T08:00:00'
const MID_WEEK = new Date('2026-11-03T12:00:00Z')

const BINDER = {
  id: 1, name: 'Kanto binder', binder_type: 'collection', pocket_layout: 9, color: '#EE1515',
  card_count: 3, unique_card_count: 3, is_public: false, icon_pokemon_id: null,
}
const ENTRIES = [1, 2, 3].map(number => ({
  id: `kt-${number}_en`, name: `Kantomon ${number}`, set_id: 'kt', number: String(number), rarity: 'Common', images_small: null, images_large: null,
  price_market: 0, owned: true, quantity: 1, owned_quantity: 1, collection_quantity: 1, required_quantity: 1, missing_quantity: 0,
  available_quantity: 0, max_assignable_quantity: 1, variant: 'Normal', condition: 'NM', lang: 'en', printing_details: [],
  collection_item_id: 100 + number, binder_card_id: 500 + number,
  card: { id: `kt-${number}_en`, name: `Kantomon ${number}`, images_small: null, images_large: null },
}))
const GOAL = {
  id: 7, kind: 'family', params: { family: 'eeveelutions' }, title: 'Eevee and all Eeveelutions', pinned: true,
  created_at: '2026-10-29T10:00:00', completed_at: null,
  progress: { owned: 9, total: 11, missing: 2, percent: 81.8, cost_to_finish: 46.5, unpriced_missing: 0, cheapest_missing: [] },
}
const CHALLENGE = {
  week: '2026-W45', starts_at: '2026-11-02T00:00:00+00:00', ends_at: '2026-11-08T23:59:00+00:00', time_zone: 'Europe/London',
  challenge: { id: 'binder_cards', title_key: 'challenge.binder_cards', target: 20, type: 'water' },
  me: { progress: 14, finished_at: null, place: null, on_board: true },
  board: [
    { user: { id: 3, username: 'Brock', avatar_id: null }, progress: 20, finished_at: '2026-11-03T09:14:00+00:00', place: 1 },
    { user: { id: 1, username: 'Ash', avatar_id: null }, progress: 14, finished_at: null, place: null },
  ],
  finished_count: 1, trainer_count: 2, last: null,
}
const SET = { id: 'sv1_en', name: 'Scarlet & Violet', series: 'Scarlet & Violet', lang: 'en', total: 198, printed_total: 198, release_date: '2023-03-31' }

function account(overrides = {}) {
  return {
    id: 1, username: 'Ash', role: 'admin', is_active: true, must_change_password: false, avatar_id: null,
    created_at: NEW_ACCOUNT, tutorial_completed_at: null, tutorial_outcome: null, ...overrides,
  }
}

async function install(page, { user = account(), social = true, multiUser = true, binders = [BINDER], goals = [GOAL], standalone = true, ios = false, camera = 'ok', queue = false, push = null } = {}) {
  const state = { user, puts: [], clears: 0 }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.setFixedTime(MID_WEEK)
  await page.addInitScript(({ account: start, installed, camera: cameraState, queueOn, pushState }) => {
    localStorage.setItem('token', 'tour-test-token')
    if (!localStorage.getItem('user')) localStorage.setItem('user', JSON.stringify(start))
    localStorage.setItem('app_language', 'en')
    localStorage.setItem('pc.splash.enabled', '0')
    Object.defineProperty(navigator, 'standalone', { value: installed, configurable: true })
    // A camera for the scanner step: a still canvas as the video stream, so the shutter and the queue button appear.
    const fakeCamera = async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 480
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#334'
      ctx.fillRect(0, 0, 640, 480)
      if (canvas.captureStream) return canvas.captureStream(5)
      // This WebKit build has no MediaStream: a stand-in that the viewfinder accepts.
      Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { set() {}, get() { return null }, configurable: true })
      return { getTracks: () => [{ stop() {} }] }
    }
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true })
    if (cameraState === 'denied') {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => { throw new DOMException('denied', 'NotAllowedError') }, configurable: true, writable: true })
    } else if (cameraState === 'none') {
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true })
    } else {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: fakeCamera, configurable: true, writable: true })
    }
    if (queueOn) {
      const add = () => {
        if (!document.head) return false
        const meta = document.createElement('meta')
        meta.name = 'pokecollector-pwa'
        meta.content = 'sw=0;queue=1'
        document.head.appendChild(meta)
        return true
      }
      if (!add()) new MutationObserver((_, observer) => { if (add()) observer.disconnect() }).observe(document, { childList: true, subtree: true })
    }
    if (pushState) {
      // Push where the engine has none: 'default' asks and is then declined, 'granted' is already on.
      window.PushManager = window.PushManager || function PushManager() {}
      const permission = pushState === 'granted' ? 'granted' : 'default'
      window.Notification = { permission, requestPermission: async () => 'denied' }
    }
  }, { account: user, installed: standalone, camera: camera, queueOn: queue, pushState: push })
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    if (!path.startsWith('/api/')) return route.continue()
    if (path.startsWith('/api/pokedex/images/') || path.startsWith('/api/images/')) return route.fulfill({ status: 404, body: '' })
    if (path === '/api/auth/me/tutorial') {
      if (method === 'PUT') {
        const body = request.postDataJSON()
        state.puts.push(body)
        if (!state.user.tutorial_completed_at) state.user = { ...state.user, tutorial_completed_at: body.completed_at, tutorial_outcome: body.outcome }
        return route.fulfill({ json: { tutorial_completed_at: state.user.tutorial_completed_at, tutorial_outcome: state.user.tutorial_outcome } })
      }
      state.clears += 1
      state.user = { ...state.user, tutorial_completed_at: null, tutorial_outcome: null }
      return route.fulfill({ json: { tutorial_completed_at: null, tutorial_outcome: null } })
    }
    if (path === '/api/health') return route.fulfill({ json: { status: 'ok', service: 'pokemon-tcg-collection', version: '1.51.6', api_level: 1, features: ['idempotency-v1'] } })
    if (path === '/api/offline/carddb/manifest') return route.fulfill({ json: { enabled: false, format: 1, languages: {} } })
    if (path === '/api/auth/me') return route.fulfill({ json: state.user })
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: multiUser, locked: false } })
    if (path === '/api/challenge') return social ? route.fulfill({ json: CHALLENGE }) : route.fulfill({ status: 404, json: { detail: 'Not found' } })
    if (path === '/api/binders/' || path === '/api/binders') return route.fulfill({ json: binders })
    if (path === '/api/binders/1') return route.fulfill({ json: BINDER })
    if (path === '/api/binders/1/cards') {
      return route.fulfill({ json: {
        binder: BINDER, cards: ENTRIES, owned_count: 3, total_count: 3, total_required_count: 3, missing_count: 0, unique_count: 3,
        binder_value: 0, current_value: 0, cost_to_complete: 0, unavailable_collection_item_ids: [], available_collection_item_quantities: {},
      } })
    }
    if (path === '/api/binders/1/slots') return route.fulfill({ json: { version: 'v1', slots: ENTRIES.map((entry, index) => ({ slot_index: index, binder_card_id: entry.binder_card_id, copy_index: 0 })), pocket_layout: 9 } })
    if (path === '/api/goals') return route.fulfill({ json: { goals } })
    if (path === '/api/swaps' || path === '/api/swaps/') return route.fulfill({ json: [] })
    if (path === '/api/swaps/waiting') return route.fulfill({ json: { count: 0 } })
    if (path === '/api/sets/' || path === '/api/sets') return route.fulfill({ json: [SET] })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/pokedex/splash') {
      return route.fulfill({ json: {
        date: '2026-11-03', dex_id: 25, name: 'Pikachu', lang: 'en', generation: 1, region: 'Kanto', types: ['lightning'], genus: 'Mouse Pokémon',
        height_m: 0.4, weight_kg: 6, shiny: false, facts: [], sprite_url: '/api/pokedex/images/showdown/25.gif', sprite_style: 'animated',
      } })
    }
    if (path === '/api/pokedex/wtp') return route.fulfill({ json: { date: '2026-11-03', lang: 'en', answer: 25, sprite_url: '/api/pokedex/images/artwork/25.png', choices: [{ dex_id: 25, name: 'Pikachu' }, { dex_id: 1, name: 'Bulbasaur' }] } })
    if (path === '/api/progress/today') {
      return route.fulfill({ json: {
        date: '2026-11-03', streak: { current: 12, best: 12, freeze_available: false, active_today: true },
        quests: [{ id: 'review_scans', done: true }, { id: 'binder_card', done: true }, { id: 'play_wtp', done: false }],
        xp: { xp: 120, level: 3, level_start: 87, next_level_at: 150 },
        pokemon: { dex_id: 25, owned_printings: 3, cheapest: null, most_expensive: null }, wtp: { played: false, correct: false },
      } })
    }
    if (path === '/api/progress/unlocks/unseen') return route.fulfill({ json: { unlocks: [], quests: [] } })
    if (path === '/api/progress/recap/weekly') return route.fulfill({ json: { show: false, has_activity: false } })
    if (path === '/api/progress/daily/view') return route.fulfill({ json: {} })
    const responses = {
      '/api/settings/': { language: 'en', price_primary: 'trend', currency: 'GBP', tcgdex_sync_languages: 'en', ...(social ? { social_features_enabled: 'true' } : {}) },
      '/api/settings/exchange-rate': { rate: 1 },
      '/api/settings/tcgdex-filter-languages': ['en'],
      '/api/profile/': { feature_enabled: false, is_profile_public: false },
      '/api/dashboard/': { total_cards: 12, unique_cards: 9, owned_sets: 1, recent_additions: [], top_cards: [] },
      '/api/collection/': [],
      '/api/wishlist/': [],
      '/api/trades/': [],
      '/api/trades': [],
    }
    return route.fulfill({ json: responses[path] ?? {} })
  })
  void ios
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
  void browserName
  test.skip(testInfo.project.name === 'desktop', 'The tour is drawn for phones.')
})

const card = page => page.getByTestId('tour-card')
const stepIs = (page, id) => expect(card(page)).toHaveAttribute('data-step', id, { timeout: 15000 })
const target = (page, id) => page.locator(`[data-tour="${id}"]:visible`).first()

/** Do what the highlighted step asks: tap the real control, or press Next. */
async function doStep(page, id, kind) {
  await stepIs(page, id)
  if (kind === 'info') {
    await card(page).getByRole('button', { name: /^(Next|Finish)$/ }).click()
    return
  }
  // A finger, not a scroll: tap the middle of the control where it is on screen.
  const control = id === 'view-switch' ? page.locator('[data-tour="view-switch"] [data-tour-tap="book"]').first() : target(page, id)
  const box = await control.boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

const WALK = [
  ['today', 'info'], ['challenge-row', 'tap'], ['challenge-hero', 'info'],
  ['tab-collection', 'tap'], ['collection-segments', 'tap'], ['first-binder', 'tap'], ['view-switch', 'tap'],
  ['tab-scan', 'tap'], ['shutter', 'info'], ['scan-queue', 'tap'], ['queue-list', 'info'],
  ['tab-search', 'tap'], ['search-field', 'info'], ['browse-sets', 'tap'], ['sets-language', 'info'],
  ['tab-profile', 'tap'], ['tile-trades', 'tap'], ['trades-offers', 'info'], ['back', 'tap'], ['tile-goals', 'tap'], ['first-goal', 'info'],
]

async function begin(page) {
  await page.goto('/')
  await expect(page.getByRole('dialog', { name: /Welcome to PokéCollector, Ash/ })).toBeVisible({ timeout: 20000 })
}

test('a new trainer is welcomed, walks the whole tour by tapping the real controls and finishes', async ({ page }, testInfo) => {
  test.setTimeout(120000)
  const state = await install(page)
  await begin(page)
  await capture(page, testInfo, '001-welcome')
  await page.getByRole('button', { name: 'Start the tour' }).click()

  let n = 5
  for (const [id, kind] of WALK) {
    await stepIs(page, id)
    await capture(page, testInfo, `${String(n += 1).padStart(3, '0')}-${id}`)
    await doStep(page, id, kind)
  }
  // Offline features are off here (no pwa meta), so the last goals step finishes the tour.
  await expect(page.getByRole('heading', { name: "You're ready" })).toBeVisible()
  await capture(page, testInfo, '099-end')
  expect(state.puts).toHaveLength(1)
  expect(state.puts[0].outcome).toBe('finished')
  await page.getByRole('button', { name: 'Explore on my own' }).click()
  await expect(page.getByTestId('tour-center')).toHaveCount(0)

  // Done means done: a reload does not start it again.
  await page.reload()
  await page.waitForTimeout(1500)
  await expect(page.getByTestId('tour-center')).toHaveCount(0)
  await expect(page.getByTestId('tour-card')).toHaveCount(0)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pc.tour.done.1')).outcome)).toBe('finished')
})

test('Skip asks once; Keep going carries on and Skip ends it for good', async ({ page }, testInfo) => {
  const state = await install(page)
  await begin(page)
  await page.getByRole('button', { name: 'Skip the tour' }).click()
  const alert = page.getByRole('dialog', { name: 'Skip the tour?' })
  await expect(alert).toBeVisible()
  await capture(page, testInfo, '002-skip')
  await alert.getByRole('button', { name: 'Keep going' }).click()
  await expect(alert).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: /Welcome to PokéCollector/ })).toBeVisible()
  expect(state.puts).toHaveLength(0)

  // Skip works from a step, and Escape opens the same alert.
  await page.getByRole('button', { name: 'Start the tour' }).click()
  await stepIs(page, 'today')
  await page.keyboard.press('Escape')
  await expect(alert).toBeVisible()
  await alert.getByRole('button', { name: 'Skip', exact: true }).click()
  await expect(card(page)).toHaveCount(0)
  expect(state.puts).toHaveLength(1)
  expect(state.puts[0].outcome).toBe('skipped')
})

test('taps outside the highlighted control do nothing; the control itself does its job and moves on', async ({ page }) => {
  await install(page)
  await begin(page)
  await page.getByRole('button', { name: 'Start the tour' }).click()
  await stepIs(page, 'today')
  await card(page).getByRole('button', { name: 'Next' }).click()
  await stepIs(page, 'challenge-row')
  await card(page).getByRole('button', { name: /Skip/ }).waitFor()
  // The Profile tab is dimmed: a tap on it goes to the scrim, not the app.
  const profile = await page.locator('[data-tour="tab-profile"]:visible').first().boundingBox()
  await page.mouse.click(profile.x + profile.width / 2, profile.y + profile.height / 2)
  await page.waitForTimeout(400)
  expect(new URL(page.url()).pathname).toBe('/')
  await stepIs(page, 'challenge-row')
  // The hole is open: the tap reaches the app and the tour moves on.
  await target(page, 'challenge-row').click()
  await stepIs(page, 'challenge-hero')
  expect(new URL(page.url()).pathname).toBe('/leaderboard/challenge')
  // An info step swallows taps in its own hole.
  const hero = await target(page, 'challenge-hero').boundingBox()
  await page.mouse.click(hero.x + hero.width / 2, hero.y + hero.height / 2)
  await stepIs(page, 'challenge-hero')
})

test('an account with no binders and no goals is pointed at +, and Book is left out', async ({ page }) => {
  const state = await install(page, { binders: [], goals: [] })
  await begin(page)
  await page.getByRole('button', { name: 'Start the tour' }).click()
  await doStep(page, 'today', 'info')
  await doStep(page, 'challenge-row', 'tap')
  await doStep(page, 'challenge-hero', 'info')
  await doStep(page, 'tab-collection', 'tap')
  await doStep(page, 'collection-segments', 'tap')
  await stepIs(page, 'new-list')
  await expect(card(page)).toContainText('Make your first binder here')
  await doStep(page, 'new-list', 'info')
  await stepIs(page, 'tab-scan')
  for (const [id, kind] of WALK.slice(WALK.findIndex(([item]) => item === 'tab-scan'), WALK.findIndex(([item]) => item === 'tile-goals') + 1)) {
    await doStep(page, id, kind)
  }
  await stepIs(page, 'new-goal')
  await expect(card(page)).toContainText('Start your first goal')
  await card(page).getByRole('button', { name: 'Finish' }).click()
  await expect(page.getByRole('heading', { name: "You're ready" })).toBeVisible()
  expect(state.puts[0].outcome).toBe('finished')
})

test('with the social switch off there is no challenge, and Trades talks about trading in person', async ({ page }, testInfo) => {
  await install(page, { social: false })
  await begin(page)
  await page.getByRole('button', { name: 'Start the tour' }).click()
  await doStep(page, 'today', 'info')
  await stepIs(page, 'tab-collection')
  for (const [id, kind] of WALK.slice(WALK.findIndex(([item]) => item === 'tab-collection'), WALK.findIndex(([item]) => item === 'tab-profile') + 1)) {
    await doStep(page, id, kind)
  }
  await stepIs(page, 'tile-trades')
  await expect(card(page)).toContainText('Trade cards in person')
  await capture(page, testInfo, '026-tile-trades-social-off')
  await target(page, 'tile-trades').click()
  await stepIs(page, 'trades-offers')
  await expect(card(page)).toContainText('Live trade and History')
  await capture(page, testInfo, '028-trades-social-off')
})

test('an older account gets the Take the tour card; Not now counts as done and the card never returns', async ({ page }, testInfo) => {
  const state = await install(page, { user: account({ created_at: OLD_ACCOUNT }) })
  await page.goto('/')
  const tourCard = page.getByTestId('take-tour-card')
  await expect(tourCard).toBeVisible({ timeout: 20000 })
  await expect(tourCard).toContainText('Take the tour')
  await expect(tourCard).toContainText('A one-minute look around PokéCollector')
  await expect(page.getByTestId('tour-center')).toHaveCount(0) // an older account is not started by itself
  await capture(page, testInfo, '100-home-take-the-tour')
  await page.getByTestId('take-tour-not-now').click()
  await expect(tourCard).toHaveCount(0)
  await expect.poll(() => state.puts.length).toBe(1)
  expect(state.puts[0].outcome).toBe('dismissed')
  await page.reload()
  await page.waitForTimeout(1500)
  await expect(page.getByTestId('take-tour-card')).toHaveCount(0)
})

test('Start on the card runs the same tour; Settings › About › Show the tour again replays a finished one', async ({ page }) => {
  const state = await install(page, { user: account({ created_at: OLD_ACCOUNT }) })
  await page.goto('/')
  await page.getByTestId('take-tour-card').getByRole('button', { name: /Take the tour/ }).click()
  await expect(page.getByRole('dialog', { name: /Welcome to PokéCollector, Ash/ })).toBeVisible()
  await page.getByRole('button', { name: 'Skip the tour' }).click()
  await page.getByRole('dialog', { name: 'Skip the tour?' }).getByRole('button', { name: 'Skip', exact: true }).click()
  await expect.poll(() => state.puts.length).toBe(1)

  await page.goto('/settings/about')
  await page.getByTestId('settings-show-tour').click()
  await expect(page.getByRole('dialog', { name: /Welcome to PokéCollector, Ash/ })).toBeVisible({ timeout: 15000 })
  expect(state.clears).toBe(1)
  expect(new URL(page.url()).pathname).toBe('/')
})

test('single-user mode has no tour, no card and no Settings row', async ({ page }) => {
  await install(page, { multiUser: false })
  await page.goto('/')
  await page.waitForTimeout(2000)
  await expect(page.getByTestId('tour-center')).toHaveCount(0)
  await expect(page.getByTestId('take-tour-card')).toHaveCount(0)
  await page.goto('/settings/about')
  await expect(page.getByText('v1.51.6').first()).toBeVisible()
  await expect(page.getByTestId('settings-show-tour')).toHaveCount(0)
})

test('Safari asks for the Home Screen app, twice confirms, then carries on and shows the browser line', async ({ page, browserName }, testInfo) => {
  test.skip(browserName !== 'webkit', 'The iPhone Safari step needs the iPhone user agent.')
  await install(page, { standalone: false })
  await begin(page)
  await page.getByRole('button', { name: 'Start the tour' }).click()
  const hs = page.getByRole('dialog', { name: 'Add PokéCollector to your Home Screen' })
  await expect(hs).toBeVisible()
  await capture(page, testInfo, '003-homescreen')
  await hs.getByRole('button', { name: 'Carry on in the browser' }).click()
  const sure = page.getByRole('dialog', { name: 'Are you sure?' })
  await expect(sure).toBeVisible()
  await capture(page, testInfo, '004-sure1')
  await sure.getByRole('button', { name: 'Add it first' }).click()
  await expect(sure).toHaveCount(0)
  await hs.getByRole('button', { name: 'Carry on in the browser' }).click()
  await sure.getByRole('button', { name: 'Carry on in the browser' }).click()
  const really = page.getByRole('dialog', { name: 'Really carry on?' })
  await expect(really).toBeVisible()
  await capture(page, testInfo, '005-sure2')
  await really.getByRole('button', { name: 'Yes, carry on' }).click()
  await stepIs(page, 'today')
  for (const [id, kind] of WALK.slice(0, WALK.findIndex(([item]) => item === 'scan-queue'))) await doStep(page, id, kind)
  await stepIs(page, 'scan-queue')
  await expect(card(page)).toContainText('Notifications need the Home Screen app')
  await expect(card(page).getByRole('button', { name: 'Turn on notifications' })).toHaveCount(0)
  await capture(page, testInfo, '018-scan-queue-browser')
})

test('"I\'ll add it now" ends the tour part-way: nothing is written and Home says where to take it', async ({ page, browserName }) => {
  test.skip(browserName !== 'webkit', 'The iPhone Safari step needs the iPhone user agent.')
  const state = await install(page, { standalone: false })
  await begin(page)
  await page.getByRole('button', { name: 'Start the tour' }).click()
  await page.getByRole('button', { name: "I'll add it now" }).click()
  await expect(page.getByTestId('tour-center')).toHaveCount(0)
  await expect(page.getByTestId('tour-home-note')).toContainText('Open PokéCollector from your Home Screen to take the tour.')
  expect(state.puts).toHaveLength(0)
  // Not started again at once, even though it is still not done.
  await page.waitForTimeout(1500)
  await expect(page.getByTestId('tour-center')).toHaveCount(0)
})

for (const camera of ['denied', 'none']) {
  test(`the Scan steps and the notifications ask still show when the camera is ${camera}`, async ({ page, browserName }, testInfo) => {
    test.setTimeout(90000)
    const state = await install(page, { camera })
    await begin(page)
    await page.getByRole('button', { name: 'Start the tour' }).click()
    for (const [id, kind] of WALK.slice(0, WALK.findIndex(([item]) => item === 'scan-queue'))) await doStep(page, id, kind)
    await stepIs(page, 'scan-queue')
    await expect(card(page)).toContainText('Scans take a little while')
    if (browserName === 'chromium') await expect(card(page).getByRole('button', { name: 'Turn on notifications' })).toBeVisible()
    await capture(page, testInfo, `016-scan-queue-camera-${camera}`)
    await target(page, 'scan-queue').click()
    await stepIs(page, 'queue-list')
    expect(state.puts).toHaveLength(0)
  })
}

/** Do each step the tour is on until it reaches `id` (empty-account variants included). */
async function walkTo(page, id) {
  const kinds = { ...Object.fromEntries(WALK), 'new-list': 'info', 'new-goal': 'info', 'row-offline': 'tap', 'offline-card': 'info' }
  for (let guard = 0; guard < 40; guard += 1) {
    await expect(card(page)).toHaveAttribute('data-step', /.+/, { timeout: 15000 })
    const current = await card(page).getAttribute('data-step')
    if (current === id) return
    await doStep(page, current, kinds[current])
    await expect(card(page)).not.toHaveAttribute('data-step', current, { timeout: 15000 })
  }
  throw new Error(`never reached ${id}`)
}

test('frames: the notifications ask (idle, declined), Sync & offline and the end with offline features on', async ({ page }, testInfo) => {
  test.setTimeout(150000)
  await install(page, { queue: true, push: 'default', binders: [], goals: [], social: false })
  await begin(page)
  await page.getByRole('button', { name: 'Start the tour' }).click()
  await walkTo(page, 'scan-queue')
  await expect(card(page).getByRole('button', { name: 'Turn on notifications' })).toBeVisible()
  await capture(page, testInfo, '016-scan-queue-ask')
  await card(page).getByRole('button', { name: 'Turn on notifications' }).click()
  await expect(card(page)).toContainText('No problem. You can turn them on later')
  await capture(page, testInfo, '017-scan-queue-declined')
  await walkTo(page, 'row-offline')
  await capture(page, testInfo, '033-row-offline')
  await target(page, 'row-offline').click()
  await stepIs(page, 'offline-card')
  await capture(page, testInfo, '034-offline-card')
  await card(page).getByRole('button', { name: 'Finish' }).click()
  await expect(page.getByRole('heading', { name: "You're ready" })).toBeVisible()
})

test('frames: notifications already on, and an empty account (+ steps)', async ({ page }, testInfo) => {
  test.setTimeout(150000)
  await install(page, { push: 'granted', binders: [], goals: [] })
  await begin(page)
  await page.getByRole('button', { name: 'Start the tour' }).click()
  for (const [id, kind] of WALK.slice(0, 3)) await doStep(page, id, kind)
  await doStep(page, 'tab-collection', 'tap')
  await doStep(page, 'collection-segments', 'tap')
  await stepIs(page, 'new-list')
  await capture(page, testInfo, '012-new-list')
  await card(page).getByRole('button', { name: 'Next' }).click()
  await doStep(page, 'tab-scan', 'tap')
  await doStep(page, 'shutter', 'info')
  await stepIs(page, 'scan-queue')
  await expect(card(page)).toContainText('Notifications are on.')
  await capture(page, testInfo, '016-scan-queue-on')
  for (const [id, kind] of WALK.slice(WALK.findIndex(([item]) => item === 'scan-queue'), WALK.findIndex(([item]) => item === 'tile-goals') + 1)) await doStep(page, id, kind)
  await stepIs(page, 'new-goal')
  await capture(page, testInfo, '032-new-goal')
})
