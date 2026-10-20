import { expect, test } from '@playwright/test'
import en from '../../src/i18n/en.js'
import {
  ROUTES,
  backLabelKeyForPath,
  isOwnBack,
  parentForPath,
  tabForPath,
  titleKeyForPath,
} from '../../src/navigation/navConfig.js'

// The iPhone shell (docs/IOS_UI_DESIGN.md §12): runs in the mobile project and in the webkit-iphone
// project of playwright.webkit.config.js. The desktop project only checks the sidebar.

const USER = { id: 1, username: 'Shell Reviewer', role: 'admin', is_active: true, must_change_password: false, avatar_id: null }

const lookup = key => key.split('.').reduce((node, part) => node?.[part], en)

// `queue` switches the offline queue flag on (the dev server's default is off), which the sync
// center at /offline needs: with the queue off that page redirects Home.
async function installApi(page, { onLogout, queue = false } = {}) {
  if (queue) {
    await page.addInitScript(() => {
      const add = () => {
        const meta = document.createElement('meta')
        meta.name = 'pokecollector-pwa'
        meta.content = 'sw=0;queue=1'
        document.head.appendChild(meta)
      }
      if (document.head) add()
      else document.addEventListener('DOMContentLoaded', add)
    })
  }
  await page.addInitScript(user => {
    localStorage.setItem('token', 'shell-test-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
  }, USER)

  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: USER })
    if (path === '/api/auth/logout') {
      onLogout?.()
      return route.fulfill({ json: {} })
    }
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/dashboard/') return route.fulfill({ json: { total_cards: 12, owned_sets: 3, recent_additions: [], top_cards: [] } })
    if (path === '/api/cards/recognize/jobs') return route.fulfill({ json: { jobs: [] } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    if (path.startsWith('/api/images/') || path.startsWith('/api/pokedex/images/')) return route.fulfill({ status: 404, json: {} })
    if (path === '/api/pokedex' || path === '/api/pokedex/') return route.fulfill({ json: { entries: [], summary: { total: 1025, owned: 10, missing: 1015 } } })
    if (path.startsWith('/api/social/achievements/')) return route.fulfill({ json: { achievements: [], earned: 0, total: 20 } })
    return route.fulfill({ json: [] })
  })
}

// Concrete URLs for each pattern of §4.2 (redirects are covered below).
const SAMPLE = {
  '/binders/:binderId': '/binders/1',
  '/decks/:deckId': '/decks/1',
  '/sets/series/:seriesKey': '/sets/series/sv',
  '/sets/:setId': '/sets/base1_en',
  '/pokedex/:dexId': '/pokedex/25',
  '/scans/:jobId': '/scans/1',
  '/leaderboard/compare/:userId': '/leaderboard/compare/2',
  '/collection/user/:userId': '/collection/user/2',
  '/achievements/:userId': '/achievements/2',
  '/settings/:section': '/settings/appearance',
}
const sample = pattern => SAMPLE[pattern] ?? pattern

test.describe('shell on a phone', () => {
  test.skip(({ viewport }) => viewport.width >= 1024, 'the phone shell is not shown at desktop width')

  // One test per route: a fresh page each time (one long test made WebKit in CI run out of steam).
  for (const route of ROUTES) {
    const url = sample(route.path)
    test(`${route.path} shows the tab bar, the right tab, title and back target`, async ({ page }) => {
      await installApi(page, { queue: route.path === '/offline' })
      await page.goto(url)
      await expect(page.getByTestId('tab-bar'), url).toBeVisible()
      await expect(page.getByTestId('nav-bar'), url).toBeVisible()

      const tab = tabForPath(url)
      const current = page.getByTestId('tab-bar').locator('[aria-current="page"]')
      if (tab) await expect(current, url).toHaveAttribute('data-testid', `tab-${tab}`)
      else await expect(current, url).toHaveCount(0)
      if (route.section === 'scan') await expect(page.getByTestId('scan-button'), url).toHaveAttribute('data-active', 'true')

      await expect(page.getByTestId('nav-title'), url).toHaveText(lookup(titleKeyForPath(url)))

      const back = page.getByTestId('nav-back')
      if (route.kind === 'root' || isOwnBack(url)) {
        await expect(back, url).toHaveCount(0)
      } else {
        const labelKey = backLabelKeyForPath(url)
        // The scan inbox goes back to the previous screen: Home after a cold start.
        await expect(back, url).toHaveText(labelKey ? lookup(labelKey) : en.nav.home)
      }
    })
  }

  test('redirects: /dashboard, /decks and unknown paths', async ({ page }) => {
    await installApi(page)
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/$/)
    await page.goto('/decks')
    await expect(page).toHaveURL(/\/binders$/)
    await page.goto('/definitely/not/a/page')
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByTestId('tab-bar')).toBeVisible()
  })

  // A deep-linked pushed page has a back button that lands on its parent (one test per route).
  // The deck editor registers its own nav bar (with its back button) only once it has a deck, which
  // this mock does not provide; its back target is covered by the unit tests of `useBack`.
  const NEEDS_PAGE_DATA = new Set(['/decks/:deckId'])
  const pushed = ROUTES.filter(route => route.kind === 'pushed' && !NEEDS_PAGE_DATA.has(route.path) && !isOwnBack(sample(route.path)) && parentForPath(sample(route.path)))
  test('there are pushed pages with a back button to check', () => {
    expect(pushed.length).toBeGreaterThan(8)
  })
  for (const route of pushed) {
    const url = sample(route.path)
    test(`${route.path}: back lands on the parent`, async ({ page }) => {
      await installApi(page, { queue: route.path === '/offline' })
      await page.goto(url)
      await expect(page.getByTestId('nav-title')).toHaveText(lookup(titleKeyForPath(url)))
      // The page may register its own nav bar options as its chunk loads, which re-renders the bar
      // under the pointer; retry the tap until it lands.
      await expect(async () => {
        await page.getByTestId('nav-back').click({ timeout: 3000 })
        await expect(page).toHaveURL(new RegExp(`${parentForPath(url)}$`), { timeout: 3000 })
      }, url).toPass({ timeout: 25000 })
    })
  }

  test('tabs: switching remembers the stack, re-tapping goes to the root, then to the top', async ({ page }) => {
    await installApi(page)
    await page.goto('/profile')
    await page.getByTestId('profile-settings').click()
    await expect(page).toHaveURL(/\/settings$/)
    // The router renders the new location only once the lazy page has loaded.
    await expect(page.getByTestId('settings-section-account')).toBeVisible()

    const tab = key => page.getByTestId(`tab-${key}`)
    // Each step waits for the nav title: the shell updates once the lazy page has loaded.
    const title = page.getByTestId('nav-title')
    await tab('search').click()
    await expect(title).toHaveText('Search')
    await tab('profile').click()
    await expect(title).toHaveText('Settings')
    await expect(page).toHaveURL(/\/settings$/)
    await tab('profile').click()
    await expect(title).toHaveText('Profile')
    await expect(page).toHaveURL(/\/profile$/)

    // Reduced motion makes the scroll to the top instant (smooth scrolling stalls in headless WebKit).
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/search')
    await expect(title).toHaveText('Search')
    await page.evaluate(() => {
      const filler = document.createElement('div')
      filler.style.height = '3000px'
      document.querySelector('main').appendChild(filler)
      window.scrollTo(0, 800)
    })
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(400)
    await tab('search').click()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(5)
  })

  test('Scan opens from every tab and closes back to the same page', async ({ page }) => {
    await installApi(page)
    for (const path of ['/', '/collection', '/search', '/profile']) {
      await page.goto(path)
      await page.getByTestId('scan-button').click()
      await expect(page.getByText('0/50 Photos')).toBeVisible()
      await expect(page.getByTestId('tab-bar')).toHaveCount(0)
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).first().click()
      await expect(page.getByText('0/50 Photos')).toBeHidden()
      await expect(page.getByTestId('tab-bar')).toBeVisible()
      await expect(page).toHaveURL(new RegExp(`${path === '/' ? '/$' : `${path}$`}`))
    }
  })

  test('Profile: Log out signs out through the logout flow', async ({ page }) => {
    let loggedOut = 0
    await installApi(page, { onLogout: () => { loggedOut += 1 } })
    await page.goto('/profile')
    await page.getByRole('button', { name: 'Logout', exact: true }).click()
    await expect.poll(() => loggedOut).toBe(1)
    await page.waitForURL('**/login')
  })

  test('the nav bar sticks to the top while a long pushed page scrolls', async ({ page }) => {
    await installApi(page)
    await page.goto('/settings')
    await expect(page.getByTestId('settings-section-account')).toBeVisible()
    await page.evaluate(() => {
      const filler = document.createElement('div')
      filler.style.height = '3000px'
      document.querySelector('main').appendChild(filler)
      window.scrollTo(0, 800)
    })
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(400)
    const top = await page.getByTestId('nav-bar').evaluate(el => el.getBoundingClientRect().top)
    expect(Math.round(top)).toBe(0)
    const back = await page.getByTestId('nav-back').boundingBox()
    expect(back.y).toBeGreaterThanOrEqual(0)
    expect(back.y + back.height).toBeLessThanOrEqual(100)
  })

  test('the shell has no second <header> and one <main>', async ({ page }) => {
    await installApi(page)
    await page.goto('/collection')
    await expect(page.getByTestId('nav-bar')).toBeVisible()
    expect(await page.locator('header').count()).toBe(0)
    expect(await page.locator('main').count()).toBe(1)
  })

  test('Profile on a phone', async ({ page }) => {
    await installApi(page)
    await page.goto('/profile')
    await expect(page.getByTestId('profile-tiles')).toBeVisible()
    await expect(page.locator('main')).toHaveScreenshot('profile-shell.png', { maxDiffPixelRatio: 0.05 })
  })
})

test.describe('shell on a desktop', () => {
  test.skip(({ viewport }) => viewport.width < 1024, 'desktop only')

  test('shows the sidebar and no tab bar', async ({ page }) => {
    await installApi(page)
    await page.goto('/collection')
    await expect(page.getByTestId('sidebar-nav')).toBeVisible()
    await expect(page.getByTestId('tab-bar')).toBeHidden()
    await expect(page.getByTestId('sidebar-nav').getByRole('link', { name: 'Card Lists' })).toBeVisible()
    await page.getByTestId('sidebar-nav').getByRole('button', { name: 'Scan cards' }).click()
    await expect(page.getByText('0/50 Photos')).toBeVisible()
  })
})
