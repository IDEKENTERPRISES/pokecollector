import { expect, test } from '@playwright/test'

// Invite links and the audit log (docs/BACKEND.md "Invites and the audit log"): the public accept
// page and the admin create / copy / revoke flow, against a mocked API.

const ADMIN = { id: 1, username: 'Prof Oak', role: 'admin', is_active: true, must_change_password: false, avatar_id: null }
const NEW_USER = { id: 9, username: 'brock', role: 'trainer', avatar_id: null, must_change_password: false }

function installApi(page, { signedIn = false, checks = {} } = {}) {
  const state = {
    invites: [],
    audit: [],
    accepted: null,
    nextId: 1,
    revokes: [],
  }
  const log = (action, details = {}) => state.audit.unshift({
    id: state.audit.length + 1,
    created_at: '2026-10-20T10:00:00Z',
    actor_user_id: 1,
    actor_username: 'Prof Oak',
    action,
    target_type: 'invite',
    target_id: '1',
    ip: '203.0.113.7',
    user_agent: 'test',
    details,
  })

  return page.addInitScript(({ user, signedIn: withSession }) => {
    localStorage.setItem('app_language', 'en')
    if (withSession) {
      localStorage.setItem('token', 'invite-test-token')
      localStorage.setItem('user', JSON.stringify(user))
    }
    window.__copied = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async text => { window.__copied.push(text) } },
    })
  }, { user: ADMIN, signedIn }).then(async () => {
    await page.route('**/api/**', async route => {
      const request = route.request()
      const url = new URL(request.url())
      const path = url.pathname
      if (!path.startsWith('/api/')) return route.continue()
      const json = body => route.fulfill({ json: body })

      if (path === '/api/auth/mode') return json({ multi_user: true, locked: false })
      if (path === '/api/auth/me') {
        return signedIn ? json(ADMIN) : route.fulfill({ status: 401, json: { detail: 'Not authenticated' } })
      }
      if (path === '/api/settings/') return json({ language: 'en', currency: 'EUR' })
      if (path === '/api/settings/exchange-rate') return json({ rate: 1 })
      if (path === '/api/dashboard/') return json({ total_cards: 1, owned_sets: 1, recent_additions: [], top_cards: [] })
      if (path === '/api/cards/recognize/jobs') return json({ jobs: [] })
      if (path === '/api/sync/status') return json({ is_running: false, is_price_sync_running: false })
      if (path === '/api/auth/users') return json([{ ...ADMIN, created_at: '2026-01-01' }])

      const check = path.match(/^\/api\/auth\/invites\/([^/]+)\/check$/)
      if (check) return json(checks[check[1]] ?? { valid: false, reason: 'not_found' })
      const accept = path.match(/^\/api\/auth\/invites\/([^/]+)\/accept$/)
      if (accept) {
        state.accepted = { token: accept[1], ...request.postDataJSON() }
        return json({ access_token: 'new-user-token', token_type: 'bearer', user: NEW_USER })
      }
      if (path === '/api/auth/invites' && request.method() === 'POST') {
        const body = request.postDataJSON()
        const invite = {
          id: state.nextId++,
          status: 'pending',
          role: body.role,
          note: body.note ?? null,
          created_at: '2026-10-20T10:00:00Z',
          expires_at: '2026-10-27T10:00:00Z',
          created_by: { id: 1, username: 'Prof Oak' },
          used_at: null,
          used_by: null,
          revoked_at: null,
          revoked_by: null,
        }
        state.invites.unshift(invite)
        log('invite.created', { role: body.role, note: body.note ?? null })
        return json({ ...invite, token: 'secret-token-123', link: 'http://example.test/invite/secret-token-123' })
      }
      if (path === '/api/auth/invites') return json(state.invites)
      const revoke = path.match(/^\/api\/auth\/invites\/(\d+)$/)
      if (revoke && request.method() === 'DELETE') {
        const invite = state.invites.find(item => item.id === Number(revoke[1]))
        invite.status = 'revoked'
        invite.revoked_by = { id: 1, username: 'Prof Oak' }
        state.revokes.push(invite.id)
        log('invite.revoked', { role: invite.role })
        return json({ message: 'Invite revoked' })
      }
      if (path === '/api/auth/audit') return json({ entries: state.audit, next_before: null })
      return json([])
    })
    return state
  })
}

test.describe('invite page', () => {
  test('a valid link shows the form and signs the new trainer in', async ({ page }) => {
    const state = await installApi(page, { checks: { good: { valid: true, role: 'trainer', expires_at: '2026-10-27T10:00:00Z' } } })
    await page.goto('/invite/good')

    await expect(page.getByTestId('invite-form')).toBeVisible()
    // The shell is not shown on this page.
    await expect(page.getByTestId('tab-bar')).toHaveCount(0)
    await expect(page.getByTestId('nav-bar')).toHaveCount(0)
    await expect(page.locator('#invite-username')).toHaveAttribute('autocomplete', 'username')
    await expect(page.locator('#invite-password')).toHaveAttribute('autocomplete', 'new-password')
    await expect(page.locator('#invite-confirm')).toHaveAttribute('autocomplete', 'new-password')

    const submit = page.getByRole('button', { name: 'Create account' })
    await page.locator('#invite-username').fill('brock')
    await page.locator('#invite-password').fill('correct horse battery')
    await page.locator('#invite-confirm').fill('different password')
    await expect(page.getByText('The passwords do not match.')).toBeVisible()
    await expect(submit).toBeDisabled()
    await page.locator('#invite-confirm').fill('correct horse battery')
    await expect(submit).toBeEnabled()
    await submit.click()

    await expect(page).toHaveURL(/\/$/)
    expect(state.accepted).toEqual({ token: 'good', username: 'brock', password: 'correct horse battery' })
    expect(await page.evaluate(() => localStorage.getItem('token'))).toBe('new-user-token')
  })

  for (const [reason, message] of [
    ['expired', 'This invite has expired.'],
    ['used', 'This invite has already been used.'],
    ['revoked', 'This invite was revoked.'],
    ['not_found', 'This invite link is not valid.'],
  ]) {
    test(`a ${reason} link says so and offers no form`, async ({ page }) => {
      await installApi(page, { checks: { link: { valid: false, reason } } })
      await page.goto(`/invite/${reason === 'not_found' ? 'unknown' : 'link'}`)
      await expect(page.getByTestId('invite-invalid')).toContainText(message)
      await expect(page.getByTestId('invite-form')).toHaveCount(0)
    })
  }
})

test.describe('admin invites', () => {
  test('create, copy the link once, revoke, and read the audit log', async ({ page }) => {
    const state = await installApi(page, { signedIn: true })
    await page.goto('/settings/users')
    await expect(page.getByTestId('invites-section')).toBeVisible()
    await expect(page.getByText('No invites yet.')).toBeVisible()

    await page.getByTestId('invite-create').click()
    await page.getByRole('radio', { name: 'Admin' }).click()
    await page.getByRole('radio', { name: '30 days' }).click()
    await page.getByLabel('Note (optional)').fill('for Brock')
    await page.getByRole('button', { name: 'Create link' }).click()

    const link = page.getByTestId('invite-link')
    await expect(link).toHaveValue(/\/invite\/secret-token-123$/)
    await expect(page.getByText('This link is shown only once.')).toBeVisible()
    await page.getByTestId('invite-copy').click()
    await expect(page.getByText('Link copied')).toBeVisible()
    expect(await page.evaluate(() => window.__copied)).toEqual([expect.stringMatching(/\/invite\/secret-token-123$/)])
    expect(state.invites[0]).toMatchObject({ role: 'admin', note: 'for Brock' })

    await page.getByRole('button', { name: 'Done' }).click()
    const row = page.getByTestId('invite-row-1')
    await expect(row).toContainText('for Brock')
    await expect(row.getByTestId('invite-status')).toHaveAttribute('data-status', 'pending')
    // The raw token is never shown in the list.
    await expect(page.getByText('secret-token-123')).toHaveCount(0)

    await row.click()
    await page.getByRole('button', { name: 'Revoke', exact: true }).click()
    await expect(row.getByTestId('invite-status')).toHaveAttribute('data-status', 'revoked')
    expect(state.revokes).toEqual([1])

    await page.getByTestId('audit-open').click()
    const entries = page.getByTestId('audit-entry')
    await expect(entries).toHaveCount(2)
    await expect(entries.first()).toContainText('Invite revoked')
    await expect(entries.nth(1)).toContainText('Invite created')
    await expect(entries.nth(1)).toContainText('Prof Oak')
  })
})
