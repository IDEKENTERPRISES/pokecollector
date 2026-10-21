import { expect, test } from '@playwright/test'

// Settings › Data & sync shows the running sync's progress and, once it is done, what the
// end-of-sync retries did.

const ADMIN = { id: 1, username: 'admin', role: 'admin', is_active: true, must_change_password: false }

async function installApi(page, getStatus) {
  await page.addInitScript(user => {
    localStorage.setItem('token', 'sync-token')
    localStorage.setItem('user', JSON.stringify(user))
    localStorage.setItem('app_language', 'en')
  }, ADMIN)
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    if (path === '/api/auth/mode') return route.fulfill({ json: { multi_user: true, locked: false } })
    if (path === '/api/auth/me') return route.fulfill({ json: ADMIN })
    if (path === '/api/settings/') return route.fulfill({ json: { language: 'en', currency: 'EUR' } })
    if (path === '/api/settings/exchange-rate') return route.fulfill({ json: { rate: 1 } })
    if (path === '/api/sync/status') return route.fulfill({ json: getStatus() })
    if (path.includes('contributors') || path.includes('supporters') || path.includes('custom-matches')) return route.fulfill({ json: [] })
    return route.fulfill({ json: {} })
  })
}

const IDLE = { is_running: false, is_price_sync_running: false, progress: null }

test.describe('sync progress', () => {
  test('a running sync shows its stage, the counts and a progress bar', async ({ page }) => {
    await installApi(page, () => ({
      ...IDLE,
      is_running: true,
      progress: { kind: 'full', stage: 'cards', done: 30, total: 120 },
    }))
    await page.goto('/settings/data')

    const bar = page.getByTestId('sync-progress')
    await expect(bar).toContainText('Syncing cards')
    await expect(bar).toContainText('30 of 120')
    await expect(bar.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30')
    await expect(bar).toHaveScreenshot('sync-progress.png')
  })

  test('the bar moves as the status changes and goes away when the sync ends', async ({ page }) => {
    let polls = 0
    await installApi(page, () => {
      polls += 1
      if (polls <= 1) return { ...IDLE, is_running: true, progress: { kind: 'full', stage: 'cards', done: 10, total: 100 } }
      if (polls <= 3) return { ...IDLE, is_running: true, progress: { kind: 'full', stage: 'retrying', done: 1, total: 2 } }
      return {
        ...IDLE,
        last_sync: { status: 'success', finished_at: '2026-10-20T10:00:00Z', retry: { retried: 3, recovered: 1, still_failing: 2, permanent: 0 } },
      }
    })
    await page.goto('/settings/data')

    await expect(page.getByTestId('sync-progress')).toContainText('Syncing cards')
    // Polls every 2.5 s while a sync runs
    await expect(page.getByTestId('sync-progress')).toContainText('Retrying failed lookups', { timeout: 10_000 })
    await expect(page.getByTestId('sync-progress')).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByTestId('sync-result-note')).toContainText('2 lookups still failed')
    await expect(page.getByTestId('sync-result-note')).toContainText('retried on the next sync')
  })

  test('an idle server shows no bar and no note', async ({ page }) => {
    await installApi(page, () => ({ ...IDLE, last_sync: { status: 'success', finished_at: '2026-10-20T10:00:00Z', retry: null } }))
    await page.goto('/settings/data')

    await expect(page.getByText('Sync sets & cards').first()).toBeVisible()
    await expect(page.getByTestId('sync-progress')).toHaveCount(0)
    await expect(page.getByTestId('sync-result-note')).toHaveCount(0)
  })
})
