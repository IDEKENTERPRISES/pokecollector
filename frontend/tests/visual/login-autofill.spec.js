import { expect, test } from '@playwright/test'

async function open(page, lastUser) {
  await page.addInitScript(lastUser => {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    localStorage.setItem('app_language', 'en')
    if (lastUser) localStorage.setItem('lastUser', lastUser)
    else localStorage.removeItem('lastUser')
  }, lastUser)
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/auth/me') return route.fulfill({ status: 401, json: { detail: 'no' } })
    return route.fulfill({ json: {} })
  })
  await page.goto('/login')
}

for (const [label, lastUser, usernameId, passwordId] of [
  ['username and password form', '', 'login-username', 'login-password'],
  ['welcome-back form', 'ash', 'login-username-saved', 'login-password-saved'],
]) {
  test(`${label} has a focusable username next to the password in one form`, async ({ page }) => {
    await open(page, lastUser)
    const username = page.locator(`#${usernameId}`)
    const password = page.locator(`#${passwordId}`)
    await expect(username).toBeVisible()
    await expect(username).toHaveAttribute('autocomplete', 'username')
    await expect(password).toHaveAttribute('autocomplete', 'current-password')
    await expect(username).not.toHaveAttribute('tabindex', '-1')
    await username.focus()
    await expect(username).toBeFocused()
    const sameForm = await page.evaluate(([u, p]) => {
      const a = document.getElementById(u)
      const b = document.getElementById(p)
      return Boolean(a.form) && a.form === b.form && Boolean(a.form.querySelector('[type=submit]'))
    }, [usernameId, passwordId])
    expect(sameForm).toBe(true)
    // Not visually hidden: it has a real box on screen.
    const box = await username.boundingBox()
    expect(box.width).toBeGreaterThan(40)
    expect(box.height).toBeGreaterThan(16)
  })
}
