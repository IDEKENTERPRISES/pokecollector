import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import en from '../../i18n/en'
import {
  DataWipeForm, DataWipeResult, canWipe, deleteRows, formatBytes, wipeBlocker, wipeRequest,
} from './DataWipeCard'

const t = key => key.split('.').reduce((node, part) => node?.[part], en) ?? key

const preview = {
  phrase: 'WIPE ALL DATA',
  requires_password: true,
  env_admin_ready: true,
  env_admin_problem: null,
  env_admin_username: 'boss',
  busy_reason: null,
  delete: { users: 3, collection: 120, wishlist: 0, 'cards (custom cards)': 2 },
  keep: ['settings', 'cards'],
  files: { scan_uploads: { files: 4, bytes: 2048 } },
}
const filled = { phrase: 'WIPE ALL DATA', password: 'pw', busy: false }

describe('wipeBlocker', () => {
  it('is open only when the phrase and password are right', () => {
    expect(canWipe({ preview, ...filled })).toBe(true)
    expect(wipeBlocker({ preview, ...filled, phrase: 'wipe all data' })).toBe('phrase')
    expect(wipeBlocker({ preview, ...filled, phrase: 'WIPE ALL DATA ' })).toBe('phrase')
    expect(wipeBlocker({ preview, ...filled, password: '' })).toBe('password')
  })

  it('needs no password when the instance has none (reverse-proxy sign-in)', () => {
    expect(canWipe({ preview: { ...preview, requires_password: false }, ...filled, password: '' })).toBe(true)
  })

  it('waits for the preview and refuses without the environment admin or while busy', () => {
    expect(wipeBlocker({ preview: null, ...filled })).toBe('loading')
    expect(wipeBlocker({ preview: { ...preview, env_admin_ready: false }, ...filled })).toBe('env')
    expect(wipeBlocker({ preview: { ...preview, busy_reason: 'A scan job is still running.' }, ...filled })).toBe('busy')
    expect(wipeBlocker({ preview, ...filled, busy: true })).toBe('running')
  })
})

describe('wipeRequest', () => {
  it('sends only the phrase and the password: there is no option to delete scan photos or diagnostics', () => {
    expect(wipeRequest(filled)).toEqual({ phrase: 'WIPE ALL DATA', password: 'pw' })
  })
})

describe('the numbers', () => {
  it('lists non-empty tables, biggest first', () => {
    expect(deleteRows(preview)).toEqual([['collection', 120], ['users', 3], ['cards (custom cards)', 2]])
    expect(deleteRows(null)).toEqual([])
  })

  it('formats sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

const render = (props = {}) => renderToStaticMarkup(createElement(DataWipeForm, {
  preview, state: filled, onChange: vi.fn(), onSubmit: vi.fn(), t, error: null, ...props,
}))

describe('the confirmation form', () => {
  it('shows what is deleted with counts and what is kept', () => {
    const html = render()
    expect(html).toContain('data-testid="data-wipe-delete"')
    expect(html).toContain('collection')
    expect(html).toContain('120')
    expect(html).not.toContain('wishlist')
    expect(html).toContain('data-testid="data-wipe-keep"')
    expect(html).toContain('Server settings')
    expect(html).toContain('boss')
  })

  it('has the phrase and password fields and an enabled button when filled in', () => {
    const html = render()
    expect(html).toContain('data-testid="data-wipe-phrase"')
    expect(html).toContain('data-testid="data-wipe-password"')
    expect(html).toMatch(/data-testid="data-wipe-submit"(?![^>]*disabled)/)
    expect(render({ state: { ...filled, phrase: 'nope' } })).toMatch(/disabled=""[^>]*data-testid="data-wipe-submit"|data-testid="data-wipe-submit"[^>]*disabled=""/)
  })

  it('leaves out the password field without passwords', () => {
    expect(render({ preview: { ...preview, requires_password: false } })).not.toContain('data-testid="data-wipe-password"')
  })

  it('explains why it refuses without the environment password', () => {
    const html = render({ preview: { ...preview, env_admin_ready: false } })
    expect(html).toContain('data-testid="data-wipe-env-problem"')
    expect(html).toContain('ADMIN_PASSWORD')
    expect(html).toMatch(/disabled=""/)
  })

  it('offers no way to delete scan photos or diagnostics, and says they are kept', () => {
    const html = render()
    expect(html).not.toContain('data-wipe-scan')
    expect(html).toContain('never deleted')
  })
})

describe('the result screen', () => {
  it('says to sign in with the environment account and offers to sign out', () => {
    const html = renderToStaticMarkup(createElement(DataWipeResult, {
      t, onSignOut: vi.fn(),
      result: { admin_username: 'boss', backup_file: 'pre-wipe-20261118T000000Z.sql', deleted_rows: { users: 3, collection: 120 }, files: { errors: [] } },
    }))
    expect(html).toContain('boss')
    expect(html).toContain('ADMIN_PASSWORD')
    expect(html).toContain('pre-wipe-20261118T000000Z.sql')
    expect(html).toContain('123 rows')
    expect(html).toContain('data-testid="data-wipe-signout"')
  })
})
