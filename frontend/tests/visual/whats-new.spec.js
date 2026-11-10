import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// What's new and the version history (engagement P16, docs/WELCOME_DESIGN.md §5): the sheet after an update,
// the history in Settings › About, the detail page, "Coming next" on nonprod only, and the sheet waiting for a
// tour. Every API is mocked. Runs in the Chromium "mobile" project and in "webkit-iphone" at 390 x 844. Each
// artboard frame is also written to test-results/whats-new-fidelity/<project>/ (not committed) to set beside
// the Wave 4 artboards (W4WhatsNewOne, W4WhatsNewMany, W4SettingsAbout, W4VersionList, W4VersionDetail, W4ComingNext).

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', '..', 'test-results', 'whats-new-fidelity')

const ASH = { id: 1, username: 'Ash', role: 'admin', is_active: true, must_change_password: false, avatar_id: null }
const NOW = new Date('2026-11-04T10:00:00Z')

// The spec runs against a pinned copy of the release file (Chikorita newest, Cyndaquil as the draft), so a new
// release entry or a reworded draft does not change what these tests see. The real file's rules are checked by
// src/welcome/releases.test.js.
const PINNED_RELEASES = JSON.parse(readFileSync(join(here, 'fixtures', 'whats-new-releases.json'), 'utf-8'))

// Seen ids that stand for "the account is one release behind" and so on, against the pinned release file.
const BEHIND_ONE = '2026-10-29' // saw Squirtle, missed Chikorita
const BEHIND_THREE = '2026-10-19' // saw Bulbasaur, missed Charmander, Squirtle, Chikorita

const dayOf = date => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`

// A synthetic release file for the "more than five" case: eight releases, newest first.
function manyReleases() {
  const names = ['Bayleef', 'Meganium', 'Cyndaquil', 'Quilava', 'Typhlosion', 'Totodile', 'Croconaw', 'Feraligatr']
  const releases = names.map((name, i) => {
    const day = String(28 - i).padStart(2, '0')
    return {
      id: `2026-12-${day}`, name, nameDate: false, from: `2026-12-${day}`, date: `2026-12-${day}`, kind: 'major', summary: `${name} summary`,
      highlights: [{ icon: 'star', title: `${name} headline`, text: 'One friendly sentence.' }],
      details: { new: ['Something new.'], better: [], fixed: [] }, underTheHood: [],
    }
  })
  return { releases }
}

/**
 * Signs Ash in and mocks the API. `seen` is the account's whats_new_seen; `channel` pretends to be a
 * nonprod build; `releaseFile` swaps the bundled release file; `gate` holds /api/auth/me until released.
 */
async function install(page, { seen = null, multiUser = true, channel, releaseFile = PINNED_RELEASES, gate, puts = [], failPut = false } = {}) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.setFixedTime(NOW)
  await page.addInitScript(({ account, nonprod }) => {
    localStorage.setItem('token', 'whats-new-test-token')
    localStorage.setItem('user', JSON.stringify(account))
    localStorage.setItem('app_language', 'en')
    localStorage.setItem('pc.splash.enabled', '0')
    if (nonprod) window.__PC_RELEASE_CHANNEL__ = 'nonprod'
  }, { account: ASH, nonprod: channel === 'nonprod' })
  if (releaseFile) {
    await page.route('**/src/welcome/releases.json*', route => route.fulfill({
      contentType: 'text/javascript',
      body: `export default ${JSON.stringify(releaseFile)}`,
    }))
  }
  const date = dayOf(NOW)
  const state = { seen, puts }
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/auth/me/whats-new-seen') {
      const body = request.postDataJSON()
      puts.push(body.id)
      if (failPut) return route.abort('internetdisconnected')
      state.seen = body.id
      return route.fulfill({ json: { whats_new_seen: body.id } })
    }
    if (path === '/api/auth/me') {
      if (gate) await gate
      return route.fulfill({ json: { ...ASH, whats_new_seen: state.seen } })
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
    if (path === '/api/progress/unlocks/unseen') return route.fulfill({ json: { unlocks: [], quests: [] } })
    if (path === '/api/progress/recap/weekly') return route.fulfill({ json: { show: false, has_activity: false } })
    const responses = {
      '/api/auth/mode': { multi_user: multiUser },
      '/api/settings/': { language: 'en', price_primary: 'trend', currency: 'GBP', tcgdex_sync_languages: 'en' },
      '/api/settings/tcgdex-filter-languages': ['en'],
      '/api/settings/exchange-rate': { rate: 1 },
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
  })
  await page.waitForTimeout(250)
}

async function capture(page, testInfo, name) {
  await settle(page)
  const dir = join(OUT, testInfo.project.name)
  mkdirSync(dir, { recursive: true })
  await page.screenshot({ path: join(dir, `${name}.png`), animations: 'disabled' })
}

const box = async locator => (await locator.first().boundingBox())
const near = (actual, expected, slack = 2) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(slack)

test.use({ viewport: { width: 390, height: 844 } })
test.beforeEach(({ browserName }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'The frames are phone-sized.')
  void browserName
})

const sheet = page => page.getByRole('dialog', { name: "What's new" })
const blockNames = async page => (await sheet(page).getByRole('heading', { level: 3 }).allTextContents()).map(text => text.split(',')[0])

test.describe("the What's new sheet", () => {
  test('W4WhatsNewOne: one missed release shows its name, date and three highlights', async ({ page }, testInfo) => {
    const puts = []
    await install(page, { seen: BEHIND_ONE, puts })
    await page.goto('/')
    const dialog = sheet(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: "What's new", level: 2 })).toBeVisible()
    await expect(dialog.getByRole('heading', { level: 3 })).toHaveCount(1)
    // The date is part of the heading text (VoiceOver reads name and date together).
    await expect(dialog.getByRole('heading', { level: 3 })).toHaveText(/Chikorita, 30 Oct 2026/)
    await expect(dialog.getByText('30 Oct 2026', { exact: true })).toBeVisible()
    for (const title of ['Chase goals', 'Your weekly recap', 'Goals at a glance']) await expect(dialog.getByText(title, { exact: true })).toBeVisible()
    await expect(dialog.getByText('Pick a set, a generation, an evolution family or an artist, and watch the ring fill as you collect.')).toBeVisible()
    await expect(page.getByText('Wrapped')).toHaveCount(0)

    // The artboard's numbers: 40 px circles, rows of at least 56, a 50 px full-width footer button, 16 px top corners.
    const circle = await box(dialog.locator('li span[aria-hidden="true"]'))
    near(circle.width, 40, 0.5)
    near(circle.height, 40, 0.5)
    const rows = await dialog.locator('li').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))
    for (const height of rows) expect(height).toBeGreaterThanOrEqual(56)
    const seeAll = await box(page.getByTestId('whats-new-see-all'))
    near(seeAll.height, 50, 0.5)
    near(seeAll.width, 358, 3)
    await expect(dialog.getByRole('button', { name: 'Done' })).toBeVisible()
    expect((await box(dialog.getByRole('button', { name: 'Done' }))).height).toBeGreaterThanOrEqual(44)
    await capture(page, testInfo, 'W4WhatsNewOne')
  })

  test('W4WhatsNewMany: several missed releases, newest first, each with its own highlights', async ({ page }, testInfo) => {
    await install(page, { seen: BEHIND_THREE })
    await page.goto('/')
    await expect(sheet(page)).toBeVisible()
    expect(await blockNames(page)).toEqual(['Chikorita', 'Squirtle', 'Charmander'])
    await expect(sheet(page).getByText('20–23 Oct 2026', { exact: true })).toBeVisible()
    await expect(sheet(page).getByText('29 Oct 2026', { exact: true })).toBeVisible()
    // The sheet is as tall as 92 dvh and scrolls; the footer stays pinned.
    near((await box(sheet(page))).height, 844 * 0.92, 2)
    await expect(page.getByTestId('whats-new-see-all')).toBeVisible()
    await capture(page, testInfo, 'W4WhatsNewMany')
  })

  test('a trainer last on a very old build sees everything since the first release', async ({ page }) => {
    await install(page, { seen: 'since:2026-10-17' })
    await page.goto('/')
    await expect(sheet(page)).toBeVisible()
    expect(await blockNames(page)).toEqual(['Chikorita', 'Squirtle', 'Charmander', 'Bulbasaur'])
  })

  test('the since: marker shows what is newer than the trainer\'s last visit', async ({ page }) => {
    await install(page, { seen: 'since:2026-10-21' }) // inside Charmander's 20–23 Oct
    await page.goto('/')
    await expect(sheet(page)).toBeVisible()
    expect(await blockNames(page)).toEqual(['Chikorita', 'Squirtle'])
  })

  test('more than five missed releases fold the oldest into "…and N earlier releases"', async ({ page }) => {
    await install(page, { seen: '2026-11-30', releaseFile: manyReleases() })
    await page.goto('/')
    // Eight releases in the synthetic file, newest 2026-12-28: everything is newer than the seen id.
    await expect(sheet(page)).toBeVisible()
    expect(await blockNames(page)).toEqual(['Bayleef', 'Meganium', 'Cyndaquil', 'Quilava', 'Typhlosion'])
    const earlier = page.getByTestId('whats-new-earlier')
    await expect(earlier).toHaveText('…and 3 earlier releases')
    expect((await box(earlier)).height).toBeGreaterThanOrEqual(44)
    await earlier.click()
    await expect(page).toHaveURL(/\/settings\/about\/versions$/)
    await expect(sheet(page)).toHaveCount(0)
  })

  test('a new account sees nothing, and the running release is saved for it', async ({ page }) => {
    const puts = []
    await install(page, { seen: null, puts })
    await page.goto('/')
    await expect(page.getByTestId('nav-bar')).toBeVisible()
    await expect.poll(() => puts).toEqual(['2026-10-30'])
    await expect(sheet(page)).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('pc.whatsNew.seen.1'))).toBe('2026-10-30')
  })

  test('nothing shows when the account has seen a release newer than this build', async ({ page }) => {
    const puts = []
    await install(page, { seen: '2026-12-01', puts })
    await page.goto('/')
    await expect(page.getByTestId('nav-bar')).toBeVisible()
    await page.waitForTimeout(500)
    await expect(sheet(page)).toHaveCount(0)
    expect(puts).toEqual([])
  })

  test('nothing shows when the account is up to date', async ({ page }) => {
    const puts = []
    await install(page, { seen: '2026-10-30', puts })
    await page.goto('/')
    await expect(page.getByTestId('nav-bar')).toBeVisible()
    await page.waitForTimeout(500)
    await expect(sheet(page)).toHaveCount(0)
    expect(puts).toEqual([])
  })

  test('Done counts as seen: the running release goes to the server and this device', async ({ page }) => {
    const puts = []
    await install(page, { seen: BEHIND_ONE, puts })
    await page.goto('/')
    await sheet(page).getByRole('button', { name: 'Done' }).click()
    await expect(sheet(page)).toHaveCount(0)
    await expect.poll(() => puts).toEqual(['2026-10-30'])
    expect(await page.evaluate(() => localStorage.getItem('pc.whatsNew.seen.1'))).toBe('2026-10-30')
    // It does not come back after a reload.
    await page.reload()
    await expect(page.getByTestId('nav-bar')).toBeVisible()
    await page.waitForTimeout(500)
    await expect(sheet(page)).toHaveCount(0)
  })

  test('tapping the backdrop counts as seen', async ({ page }) => {
    const puts = []
    await install(page, { seen: BEHIND_ONE, puts })
    await page.goto('/')
    await expect(sheet(page)).toBeVisible()
    await page.mouse.click(195, 20)
    await expect(sheet(page)).toHaveCount(0)
    await expect.poll(() => puts).toEqual(['2026-10-30'])
  })

  test('See everything counts as seen and opens the history', async ({ page }) => {
    const puts = []
    await install(page, { seen: BEHIND_THREE, puts })
    await page.goto('/')
    await page.getByTestId('whats-new-see-all').click()
    await expect(page).toHaveURL(/\/settings\/about\/versions$/)
    await expect(page.getByTestId('version-history')).toBeVisible()
    await expect.poll(() => puts).toEqual(['2026-10-30'])
  })

  test('offline, the dismissal is kept on this device and the sheet does not come back', async ({ page }) => {
    const puts = []
    await install(page, { seen: BEHIND_ONE, puts, failPut: true })
    await page.goto('/')
    await sheet(page).getByRole('button', { name: 'Done' }).click()
    await expect(sheet(page)).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('pc.whatsNew.seen.1'))).toBe('2026-10-30')
    // The server still says "Squirtle", but this device's copy is newer: nothing opens, and the write is retried.
    await page.reload()
    await expect(page.getByTestId('nav-bar')).toBeVisible()
    await expect.poll(() => puts.length).toBeGreaterThanOrEqual(2)
    await expect(sheet(page)).toHaveCount(0)
  })

  test('waits while a tour is showing, then opens', async ({ page }) => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    await install(page, { seen: BEHIND_ONE, gate })
    const loading = page.goto('/', { waitUntil: 'commit' })
    // The page is held on its start-up screen (the sign-in check is gated), so the module is loaded but nothing is shown yet.
    await expect(async () => {
      await page.evaluate(async () => (await import('/src/welcome/tourBus.js')).setTourActive(true))
    }).toPass({ timeout: 10000 })
    release()
    await loading
    await expect(page.getByTestId('nav-bar')).toBeVisible()
    await page.waitForTimeout(600)
    await expect(sheet(page)).toHaveCount(0)
    await page.evaluate(async () => (await import('/src/welcome/tourBus.js')).setTourActive(false))
    await expect(sheet(page)).toBeVisible()
  })

  test('works in single-user mode too', async ({ page }) => {
    await install(page, { seen: BEHIND_ONE, multiUser: false })
    await page.goto('/')
    await expect(sheet(page)).toBeVisible()
    await sheet(page).getByRole('button', { name: 'Done' }).click()
    await page.goto('/settings/about/versions')
    await expect(page.getByTestId('version-history')).toBeVisible()
    await expect(page.getByTestId('version-row-2026-10-30')).toBeVisible()
  })
})

test.describe('Settings › About and the version history', () => {
  test('W4SettingsAbout: a Version history row sits above the version row and opens the list', async ({ page }, testInfo) => {
    await install(page, { seen: '2026-10-30' })
    await page.goto('/settings/about')
    const row = page.getByTestId('settings-version-history')
    await expect(row).toBeVisible()
    await expect(row).toContainText('Version history')
    await expect(row).toContainText('What changed in each release')
    await expect(page.getByText('Welcome and releases', { exact: true })).toBeVisible()
    const app = page.getByText('v1.51.6')
    expect((await box(row)).y).toBeLessThan((await box(app)).y)
    expect((await box(row)).height).toBeGreaterThanOrEqual(44)
    await capture(page, testInfo, 'W4SettingsAbout')
    await row.click()
    await expect(page).toHaveURL(/\/settings\/about\/versions$/)
  })

  test('W4VersionList: four releases, newest first, the date under each name, "You have this" on the newest', async ({ page }, testInfo) => {
    await install(page, { seen: '2026-10-30' })
    await page.goto('/settings/about/versions')
    const list = page.getByTestId('version-history')
    await expect(list).toBeVisible()
    const rows = list.getByRole('link')
    await expect(rows).toHaveCount(4)
    const first = rows.nth(0)
    await expect(first).toContainText('Chikorita')
    await expect(first).toContainText('You have this')
    await expect(first).toContainText('30 Oct 2026')
    await expect(first).toContainText('Chase goals, a weekly recap and goals at a glance')
    await expect(rows.nth(1)).toContainText('Squirtle')
    await expect(rows.nth(2)).toContainText('20–23 Oct 2026')
    await expect(rows.nth(3)).toContainText('Bulbasaur')
    await expect(rows.nth(3)).toContainText('18–19 Oct 2026')
    await expect(list.getByText('You have this')).toHaveCount(1)
    await expect(list.getByText('Releases are named after starter Pokémon. Smaller updates take their evolutions.')).toBeVisible()
    // Rows are at least 76 px tall, as in the artboard (a long summary wraps and makes one taller).
    expect((await box(first)).height).toBeGreaterThanOrEqual(76)
    await capture(page, testInfo, 'W4VersionList')
    await expect(page.getByTestId('coming-next')).toHaveCount(0)
  })

  test('W4VersionDetail: the groups with something in them, and none without', async ({ page }, testInfo) => {
    await install(page, { seen: '2026-10-30' })
    await page.goto('/settings/about/versions')
    await page.getByTestId('version-row-2026-10-30').click()
    await expect(page).toHaveURL(/\/settings\/about\/versions\/2026-10-30$/)
    const detail = page.getByTestId('version-detail')
    await expect(detail.getByRole('heading', { name: 'Chikorita', level: 1 })).toBeVisible()
    await expect(detail).toContainText('30 Oct 2026')
    await expect(detail).toContainText('Chase goals, a weekly recap and goals at a glance.')
    await expect(detail.getByRole('heading', { name: 'New', level: 3 })).toBeVisible()
    await expect(detail.getByRole('heading', { name: 'Better', level: 3 })).toBeVisible()
    await expect(detail.getByRole('heading', { name: 'Under the hood', level: 3 })).toBeVisible()
    await expect(detail.getByRole('heading', { name: 'Fixed' })).toHaveCount(0) // Chikorita fixed nothing
    await expect(detail.getByText('Family goals count every card in an evolution family.')).toBeVisible()
    await expect(detail.getByText('Wrapped')).toHaveCount(0)
    await capture(page, testInfo, 'W4VersionDetail')
  })

  test('a release with all four groups shows all four, and an unknown id goes back to the list', async ({ page }) => {
    await install(page, { seen: '2026-10-30' })
    await page.goto('/settings/about/versions/2026-10-23')
    const detail = page.getByTestId('version-detail')
    await expect(detail.getByRole('heading', { name: 'Charmander', level: 1 })).toBeVisible()
    await expect(detail).toContainText('20–23 Oct 2026')
    for (const name of ['New', 'Better', 'Fixed', 'Under the hood']) await expect(detail.getByRole('heading', { name, level: 3 })).toBeVisible()
    await page.goto('/settings/about/versions/1999-01-01')
    await expect(page).toHaveURL(/\/settings\/about\/versions$/)
  })

  test('works offline: the history reads the bundled file', async ({ page, context }) => {
    await install(page, { seen: '2026-10-30' })
    await page.goto('/settings/about/versions')
    await expect(page.getByTestId('version-history')).toBeVisible()
    await context.setOffline(true)
    await page.getByTestId('version-row-2026-10-29').click()
    await expect(page.getByTestId('version-detail').getByRole('heading', { name: 'Squirtle', level: 1 })).toBeVisible()
    await context.setOffline(false)
  })
})

test.describe('Coming next', () => {
  test('W4ComingNext: the Cyndaquil draft tops the history on nonprod', async ({ page }, testInfo) => {
    await install(page, { seen: '2026-10-30', channel: 'nonprod' })
    await page.goto('/settings/about/versions')
    const next = page.getByTestId('coming-next')
    await expect(next).toBeVisible()
    await expect(next.getByText('Coming next', { exact: true })).toBeVisible()
    await expect(next.getByRole('heading', { name: /Cyndaquil/, level: 2 })).toBeVisible()
    await expect(next).toContainText('Draft — not released yet.')
    for (const title of ['Swap cards with friends', 'An activity feed', 'A weekly challenge']) await expect(next.getByText(title, { exact: true })).toBeVisible()
    // It is above the released ones, and it is not a What's new release (the account is up to date).
    expect((await box(next)).y).toBeLessThan((await box(page.getByTestId('version-row-2026-10-30'))).y)
    await expect(page.getByTestId('version-history').getByRole('link')).toHaveCount(5) // 4 releases + the "See full notes" link
    await expect(sheet(page)).toHaveCount(0)
    await capture(page, testInfo, 'W4ComingNext')
    await page.getByTestId('coming-next-notes').click()
    await expect(page).toHaveURL(/\/settings\/about\/versions\/next$/)
    const detail = page.getByTestId('version-detail')
    await expect(detail.getByRole('heading', { name: 'Cyndaquil', level: 1 })).toBeVisible()
    await expect(detail).toContainText('Draft — not released yet.')
    await expect(detail.getByRole('heading', { name: 'New', level: 3 })).toBeVisible()
  })

  test("Test What's new: a row reloads the app and opens the real sheet as if updated from that release", async ({ page }, testInfo) => {
    const puts = []
    await install(page, { seen: '2026-10-30', channel: 'nonprod', puts })
    await page.goto('/settings/about/versions')
    await page.getByTestId('test-whats-new-before').scrollIntoViewIfNeeded()
    await capture(page, testInfo, 'W4TestWhatsNew')
    await expect(page.getByTestId('test-whats-new-2026-10-29')).toContainText('As if I last had Squirtle')
    await expect(page.getByTestId('test-whats-new-2026-10-23')).toContainText('As if I last had Charmander')
    await expect(page.getByTestId('test-whats-new-2026-10-19')).toContainText('As if I last had Bulbasaur')
    await expect(page.getByTestId('test-whats-new-before')).toContainText("As if I'm on a build before Bulbasaur")
    await page.getByTestId('test-whats-new-2026-10-23').click()
    await expect(sheet(page)).toBeVisible()
    expect(await blockNames(page)).toEqual(['Chikorita', 'Squirtle'])
    expect(await page.evaluate(() => localStorage.getItem('pc.whatsNew.test.1'))).toBeNull() // used once
    await sheet(page).getByRole('button', { name: 'Done' }).click()
    await expect.poll(() => puts).toEqual(['2026-10-30'])
    await page.reload()
    await expect(page.getByTestId('nav-bar')).toBeVisible()
    await page.waitForTimeout(500)
    await expect(sheet(page)).toHaveCount(0)
  })

  test('is not shown on a deploy-style build, and its detail route goes back to the list', async ({ page }) => {
    await install(page, { seen: '2026-10-30' })
    await page.goto('/settings/about/versions')
    await expect(page.getByTestId('version-history')).toBeVisible()
    await expect(page.getByTestId('coming-next')).toHaveCount(0)
    await expect(page.getByText("Test What's new")).toHaveCount(0)
    await expect(page.getByText('Cyndaquil')).toHaveCount(0)
    await page.goto('/settings/about/versions/next')
    await expect(page).toHaveURL(/\/settings\/about\/versions$/)
    await expect(page.getByText('Cyndaquil')).toHaveCount(0)
  })
})
