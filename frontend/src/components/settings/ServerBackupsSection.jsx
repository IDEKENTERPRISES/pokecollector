import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, RotateCcw } from 'lucide-react'
import toast from 'react-hot-toast'
import { downloadServerBackup, getServerBackups } from '../../api/client'
import { useAuth } from '../../contexts/AuthContext'
import { useSettings } from '../../contexts/SettingsContext'

/** "12.3 MB" for a backup size. */
export function formatBackupSize(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** The i18n key of a backup's kind label. */
export function kindKey(kind) {
  return ['pre-wipe', 'pre-upgrade', 'download'].includes(kind) ? `settings.serverBackups.kind.${kind}` : 'settings.serverBackups.kind.other'
}

/** Restore is only possible once the exact file name is typed (and the password, when logins are on). */
export function canConfirmRestore({ typed, filename, password, needsPassword, busy }) {
  if (busy || !filename || typed !== filename) return false
  return !needsPassword || Boolean(password)
}

/** The list of server backups, newest first, with Download and Restore. Pure: data and handlers come in as props. */
export function ServerBackupList({ backups, t, onDownload, onAskRestore, restoring, formatDate = value => new Date(value).toLocaleString() }) {
  if (!backups.length) {
    return <p className="px-4 py-3 text-footnote text-text-secondary" data-testid="server-backups-empty">{t('settings.serverBackups.empty')}</p>
  }
  return (
    <ul className="divide-y-[0.5px] divide-border" data-testid="server-backups-list">
      {backups.map(item => (
        <li key={item.name} className="space-y-1 px-4 py-3" data-testid="server-backup-row">
          <p className="text-subheadline font-semibold" style={{ overflowWrap: 'anywhere' }}>{item.name}</p>
          <p className="text-caption-1 text-text-secondary">
            {t(kindKey(item.kind))} · {formatDate(item.modified)} · {formatBackupSize(item.size)}
          </p>
          <div className="flex gap-2 pt-1">
            <button type="button" className="btn-secondary-sm" data-testid="server-backup-download" onClick={() => onDownload(item.name)}>
              <Download size={13} /> {t('settings.serverBackups.download')}
            </button>
            <button type="button" className="btn-secondary-sm text-red-400" data-testid="server-backup-restore" disabled={restoring} onClick={() => onAskRestore(item.name)}>
              <RotateCcw size={13} /> {t('settings.serverBackups.restore')}
            </button>
          </div>
        </li>
      ))}
    </ul>
  )
}

/** The typed confirmation for one restore. */
export function RestoreConfirm({ filename, typed, password, needsPassword, busy, t, onTyped, onPassword, onConfirm, onCancel }) {
  const ok = canConfirmRestore({ typed, filename, password, needsPassword, busy })
  return (
    <div className="space-y-3 border-t-[0.5px] border-border px-4 py-3" data-testid="server-backup-confirm">
      <p className="text-footnote text-red-400" role="alert">{t('settings.serverBackups.warning').replace('{name}', filename)}</p>
      <label className="block space-y-1">
        <span className="text-subheadline font-semibold">{t('settings.serverBackups.typeName').replace('{name}', filename)}</span>
        <input
          className="input w-full" value={typed} autoComplete="off" autoCapitalize="off" spellCheck={false}
          data-testid="server-backup-typed" onChange={event => onTyped(event.target.value)}
        />
      </label>
      {needsPassword && (
        <label className="block space-y-1">
          <span className="text-subheadline font-semibold">{t('settings.users.password')}</span>
          <input
            className="input w-full" type="password" value={password} autoComplete="current-password"
            data-testid="server-backup-password" onChange={event => onPassword(event.target.value)}
          />
        </label>
      )}
      <div className="flex gap-2">
        <button type="button" className="btn-secondary flex-1 justify-center" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="button" className="btn-danger flex-1 justify-center" disabled={!ok} data-testid="server-backup-confirm-button" onClick={onConfirm}>
          {t('settings.serverBackups.restoreNow')}
        </button>
      </div>
    </div>
  )
}

/** Settings > Data & sync > Server backups (admin only). `onRestore(filename, password)` starts the restore and follows it. */
export default function ServerBackupsSection({ onRestore, restoring }) {
  const { t } = useSettings()
  const { multiUser } = useAuth()
  const { data, isError, refetch } = useQuery({ queryKey: ['server-backups'], queryFn: getServerBackups, staleTime: 0 })
  const [asking, setAsking] = useState(null)
  const [typed, setTyped] = useState('')
  const [password, setPassword] = useState('')

  const close = () => { setAsking(null); setTyped(''); setPassword('') }
  const download = async name => {
    try {
      await downloadServerBackup(name)
    } catch (error) {
      toast.error(error?.response?.data?.detail || error?.message || t('settings.serverBackups.failed'))
    }
  }
  const confirm = async () => {
    const name = asking
    const pw = password
    close()
    await onRestore(name, pw)
  }

  return (
    <section className="space-y-1" data-testid="server-backups">
      <h2 className="px-4 pb-1.5 text-footnote text-text-secondary">{t('settings.serverBackups.title')}</h2>
      <div className="overflow-hidden rounded-xl bg-card">
        <p className="px-4 pt-3 text-footnote text-text-secondary">{t('settings.serverBackups.intro')}</p>
        {isError ? (
          <p className="px-4 py-3 text-footnote text-red-400" role="alert">
            {t('settings.serverBackups.failed')} <button type="button" className="underline" onClick={() => refetch()}>{t('common.retry')}</button>
          </p>
        ) : (
          <ServerBackupList backups={data ?? []} t={t} onDownload={download} onAskRestore={setAsking} restoring={restoring} />
        )}
        {asking && (
          <RestoreConfirm
            filename={asking} typed={typed} password={password} needsPassword={Boolean(multiUser)} busy={restoring} t={t}
            onTyped={setTyped} onPassword={setPassword} onConfirm={confirm} onCancel={close}
          />
        )}
      </div>
    </section>
  )
}
