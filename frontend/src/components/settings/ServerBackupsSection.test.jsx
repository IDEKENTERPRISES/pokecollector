import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import en from '../../i18n/en'
import { RestoreConfirm, ServerBackupList, canConfirmRestore, formatBackupSize, kindKey } from './ServerBackupsSection'

const t = key => key.split('.').reduce((node, part) => node?.[part], en) ?? key

const backups = [
  { name: 'pre-wipe-20261118T120000Z.sql', size: 5 * 1024 * 1024, modified: '2026-11-18T12:00:00+00:00', kind: 'pre-wipe' },
  { name: 'pre_upgrade_1.0_to_1.1_20261110_090000.sql', size: 2048, modified: '2026-11-10T09:00:00+00:00', kind: 'pre-upgrade' },
  { name: 'odd.sql', size: 10, modified: '2026-11-01T09:00:00+00:00', kind: 'other' },
]
const list = (props = {}) => renderToStaticMarkup(createElement(ServerBackupList, {
  backups, t, onDownload: vi.fn(), onAskRestore: vi.fn(), restoring: false, formatDate: v => v.slice(0, 10), ...props,
}))

describe('the server backup list', () => {
  it('shows name, kind, date and size for each file, in the order given (newest first)', () => {
    const html = list()
    expect(html.match(/data-testid="server-backup-row"/g)).toHaveLength(3)
    expect(html.indexOf('pre-wipe-20261118T120000Z.sql')).toBeLessThan(html.indexOf('pre_upgrade_1.0'))
    expect(html).toContain('Before a wipe of all user data')
    expect(html).toContain('2026-11-18')
    expect(html).toContain('5.0 MB')
    expect(html).toContain('2.0 KB')
  })

  it('has Download and Restore on every row, and disables Restore while one runs', () => {
    expect(list().match(/data-testid="server-backup-download"/g)).toHaveLength(3)
    expect(list().match(/data-testid="server-backup-restore"/g)).toHaveLength(3)
    expect(list({ restoring: true })).toMatch(/data-testid="server-backup-restore" disabled=""/)
  })

  it('says so when there are no backups', () => {
    expect(list({ backups: [] })).toContain('data-testid="server-backups-empty"')
  })

  it('formats sizes and kinds', () => {
    expect(formatBackupSize(0)).toBe('0 B')
    expect(formatBackupSize(1536)).toBe('1.5 KB')
    expect(kindKey('pre-wipe')).toBe('settings.serverBackups.kind.pre-wipe')
    expect(kindKey('weird')).toBe('settings.serverBackups.kind.other')
  })
})

describe('the restore confirmation', () => {
  const name = 'pre-wipe-20261118T120000Z.sql'

  it('needs the exact file name, and the password when logins are on', () => {
    expect(canConfirmRestore({ typed: name, filename: name, password: 'pw', needsPassword: true, busy: false })).toBe(true)
    expect(canConfirmRestore({ typed: name.slice(1), filename: name, password: 'pw', needsPassword: true, busy: false })).toBe(false)
    expect(canConfirmRestore({ typed: '', filename: name, password: 'pw', needsPassword: false, busy: false })).toBe(false)
    expect(canConfirmRestore({ typed: name, filename: name, password: '', needsPassword: true, busy: false })).toBe(false)
    expect(canConfirmRestore({ typed: name, filename: name, password: '', needsPassword: false, busy: false })).toBe(true)
    expect(canConfirmRestore({ typed: name, filename: name, password: 'pw', needsPassword: true, busy: true })).toBe(false)
  })

  const confirm = (props = {}) => renderToStaticMarkup(createElement(RestoreConfirm, {
    filename: name, typed: '', password: '', needsPassword: true, busy: false, t,
    onTyped: vi.fn(), onPassword: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn(), ...props,
  }))

  it('warns that everything is replaced, naming the file, and keeps Restore off until confirmed', () => {
    const html = confirm()
    expect(html).toContain('replaces EVERYTHING')
    expect(html).toContain(name)
    expect(html).toMatch(/disabled=""[^>]*data-testid="server-backup-confirm-button"|data-testid="server-backup-confirm-button"[^>]*disabled=""/)
    expect(confirm({ typed: name, password: 'pw' })).not.toMatch(/disabled=""[^>]*data-testid="server-backup-confirm-button"/)
  })

  it('leaves out the password field when logins are off', () => {
    expect(confirm({ needsPassword: false })).not.toContain('data-testid="server-backup-password"')
  })
})

describe('the texts that point at the backups', () => {
  it('tell the admin where the pre-wipe backup is', () => {
    expect(en.adminWipe.backupNote).toContain('Server backups')
    expect(en.adminWipe.doneBackup).toContain('Server backups')
    expect(en.adminWipe.backupNote).not.toContain('Settings > Backup ')
  })
})
