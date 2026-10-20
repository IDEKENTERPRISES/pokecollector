import { expect, test } from '@playwright/test'

const ADMIN = { id: 1, username: 'admin', role: 'admin', is_active: true, must_change_password: false }
const TRAINER = { id: 2, username: 'misty', role: 'trainer', is_active: true, must_change_password: false }

async function installApi(page, user) {
  await page.addInitScript(user => {
    localStorage.setItem('token', 'settings-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
  }, user)
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: user })
    if (path === '/api/auth/users') return route.fulfill({ json: [ADMIN, TRAINER] })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR', price_primary: 'trend' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/settings/currencies') return route.fulfill({ json: { currencies: [{ code: 'EUR', name: 'Euro', symbol: '€' }] } })
    if (path === '/api/settings/scanner') return route.fulfill({ json: { provider: 'none', providers: [], request_timeout_seconds: 60 } })
    if (path === '/api/sync/status') return route.fulfill({ json: { is_running: false, is_price_sync_running: false } })
    if (path.includes('contributors') || path.includes('supporters') || path.includes('custom-matches')) return route.fulfill({ json: [] })
    return route.fulfill({ json: {} })
  })
}

const SECTIONS = ['account', 'appearance', 'scanner', 'notifications', 'data', 'users', 'community', 'about']

for (const section of SECTIONS) {
  test(`admin in multi-user mode can open /settings/${section} without a crash`, async ({ page }) => {
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await installApi(page, ADMIN)
    await page.goto(`/settings/${section}`)
    await expect(page.locator('main h1')).toHaveCount(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    expect(errors).toEqual([])
  })
}

test('account shows change password and sign out other devices to a trainer', async ({ page }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await installApi(page, TRAINER)
  await page.goto('/settings/account')
  await expect(page.locator('#change-current-password')).toBeVisible()
  await expect(page.locator('#change-new-password')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign out other devices' })).toBeVisible()
  expect(errors).toEqual([])
})

test('export and restore are not offered to a trainer', async ({ page }) => {
  await installApi(page, TRAINER)
  await page.goto('/settings/data')
  await expect(page).toHaveURL(/\/settings$/)
})
