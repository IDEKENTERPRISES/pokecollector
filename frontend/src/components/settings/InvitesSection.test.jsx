import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import en from '../../i18n/en'
import { StatusChip, copyText } from './InvitesSection'
import { auditActionLabel, auditDetailText } from './AuditLogSheet'

const t = key => key.split('.').reduce((node, part) => node?.[part], en) ?? key

describe('StatusChip', () => {
  it('marks each status for styling and tests', () => {
    for (const status of ['pending', 'used', 'expired', 'revoked']) {
      const markup = renderToStaticMarkup(createElement(StatusChip, { status, label: t(`invites.status.${status}`) }))
      expect(markup).toContain(`data-status="${status}"`)
      expect(markup).toContain(en.invites.status[status])
    }
  })
})

describe('copyText', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses the clipboard API', async () => {
    const writeText = vi.fn().mockResolvedValue()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    expect(await copyText('https://x.test/invite/abc')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('https://x.test/invite/abc')
  })

  it('falls back to a selected textarea when the clipboard API is missing', async () => {
    const field = { style: {}, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() }
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', {
      createElement: vi.fn(() => field),
      body: { appendChild: vi.fn() },
      execCommand: vi.fn(() => true),
    })
    expect(await copyText('link')).toBe(true)
    expect(field.value).toBe('link')
    expect(field.select).toHaveBeenCalled()
    expect(field.remove).toHaveBeenCalled()
  })

  it('reports failure when nothing can copy', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', {
      createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove() {} }),
      body: { appendChild() {} },
      execCommand: () => { throw new Error('blocked') },
    })
    expect(await copyText('link')).toBe(false)
  })
})

describe('auditDetailText', () => {
  it('summarises refusals, roles and accepted usernames', () => {
    expect(auditDetailText({ action: 'invite.rejected', details: { reason: 'expired' } }, t)).toBe('Reason: This invite has expired.')
    expect(auditDetailText({ action: 'invite.created', details: { role: 'admin', note: 'for Brock' } }, t)).toBe('Role admin · “for Brock”')
    expect(auditDetailText({ action: 'invite.accepted', details: { role: 'trainer', username: 'brock' } }, t)).toBe('Role trainer · New user brock')
    expect(auditDetailText({ action: 'invite.revoked', details: {} }, t)).toBe('')
  })

  it('falls back to the raw action for an unknown one', () => {
    expect(auditActionLabel('user.something_new', t)).toBe('user.something_new')
  })

  it('has a label for every audit action the backend writes', () => {
    for (const action of ['invite.created', 'invite.revoked', 'invite.accepted', 'invite.rejected', 'user.created_via_invite']) {
      expect(auditActionLabel(action, t)).not.toBe(action)
    }
  })
})
