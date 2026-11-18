import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { getDataWipePreview, runDataWipe } from '../../api/dataWipe'
import { writeStoredEpoch, wipeLocalData } from '../../offline/dataEpoch'
import { useSettings } from '../../contexts/SettingsContext'

export const CONFIRM_PHRASE = 'WIPE ALL DATA'

function fill(text, values) {
  return Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, String(value)), text)
}

/** "12.3 MB" for the file sizes of the preview. */
export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

/** The table rows with something in them, biggest first: what the wipe deletes. */
export function deleteRows(preview) {
  return Object.entries(preview?.delete ?? {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
}

/** Why the Wipe button is still off, or null when everything needed is filled in. The server checks all of it again. */
export function wipeBlocker({ preview, phrase, password, busy }) {
  if (!preview) return 'loading'
  if (!preview.env_admin_ready) return 'env'
  if (preview.busy_reason) return 'busy'
  if (busy) return 'running'
  if (phrase !== (preview.phrase || CONFIRM_PHRASE)) return 'phrase'
  if (preview.requires_password && !password) return 'password'
  return null
}

export function canWipe(state) {
  return wipeBlocker(state) === null
}

/** The request body. */
export function wipeRequest({ phrase, password }) {
  return { phrase, password }
}

/** The form: what goes, what stays, the confirmation fields. Pure (state comes in through props). */
export function DataWipeForm({ preview, state, onChange, onSubmit, t, error }) {
  const blocker = wipeBlocker({ preview, ...state })
  const rows = deleteRows(preview)
  const files = preview?.files
  return (
    <div className="space-y-4" data-testid="data-wipe-form">
      <p className="text-footnote text-text-secondary">{t('adminWipe.intro')}</p>

      {preview && !preview.env_admin_ready && (
        <p className="rounded-xl bg-fill-tertiary p-3 text-footnote text-red-400" role="alert" data-testid="data-wipe-env-problem">
          {t('adminWipe.envMissing')}
        </p>
      )}
      {preview?.busy_reason && (
        <p className="rounded-xl bg-fill-tertiary p-3 text-footnote text-amber-400" role="status" data-testid="data-wipe-busy">
          {preview.busy_reason}
        </p>
      )}

      <div className="space-y-1">
        <h3 className="text-subheadline font-semibold">{t('adminWipe.willDelete')}</h3>
        {rows.length === 0 ? (
          <p className="text-footnote text-text-secondary">{t('adminWipe.nothing')}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-x-4 text-footnote text-text-secondary" data-testid="data-wipe-delete">
            {rows.map(([name, count]) => (
              <li key={name} className="flex justify-between gap-2"><span style={{ overflowWrap: 'anywhere' }}>{name}</span><span>{count}</span></li>
            ))}
          </ul>
        )}
        {files && (
          <p className="text-footnote text-text-secondary" data-testid="data-wipe-files">
            {fill(t('adminWipe.uploads'), { n: files.scan_uploads?.files ?? 0, size: formatBytes(files.scan_uploads?.bytes) })}
          </p>
        )}
      </div>

      <div className="space-y-1">
        <h3 className="text-subheadline font-semibold">{t('adminWipe.willKeep')}</h3>
        <p className="text-footnote text-text-secondary" data-testid="data-wipe-keep">{t('adminWipe.keepList')}</p>
        <p className="text-footnote text-text-secondary">{t('adminWipe.backupNote')}</p>
        <p className="text-footnote text-text-secondary">{t('adminWipe.afterNote')}</p>
        {preview?.env_admin_username && (
          <p className="text-footnote text-text-secondary">{fill(t('adminWipe.envAdmin'), { name: preview.env_admin_username })}</p>
        )}
      </div>

      <label className="block space-y-1">
        <span className="text-subheadline font-semibold">{fill(t('adminWipe.typePhrase'), { phrase: preview?.phrase || CONFIRM_PHRASE })}</span>
        <input
          className="input w-full" value={state.phrase} autoComplete="off" autoCapitalize="off" spellCheck={false}
          data-testid="data-wipe-phrase" onChange={event => onChange({ phrase: event.target.value })}
        />
      </label>
      {preview?.requires_password && (
        <label className="block space-y-1">
          <span className="text-subheadline font-semibold">{t('adminWipe.password')}</span>
          <input
            className="input w-full" type="password" value={state.password} autoComplete="current-password"
            data-testid="data-wipe-password" onChange={event => onChange({ password: event.target.value })}
          />
        </label>
      )}

      {error && <p className="text-footnote text-red-400" role="alert" data-testid="data-wipe-error">{error}</p>}

      <button
        type="button" className="btn-danger w-full justify-center" disabled={blocker !== null} data-testid="data-wipe-submit"
        onClick={onSubmit}
      >
        {blocker === 'running' ? t('adminWipe.running') : t('adminWipe.button')}
      </button>
    </div>
  )
}

/** What happened, and the one thing to do next: sign in again with the environment account. */
export function DataWipeResult({ result, onSignOut, t }) {
  const deleted = Object.values(result?.deleted_rows ?? {}).reduce((sum, n) => sum + n, 0)
  return (
    <div className="space-y-3" data-testid="data-wipe-result">
      <h3 className="text-headline font-semibold">{t('adminWipe.doneTitle')}</h3>
      <p className="text-footnote text-text-secondary">{fill(t('adminWipe.doneRows'), { n: deleted })}</p>
      <p className="text-footnote text-text-secondary" data-testid="data-wipe-backup-file">
        {fill(t('adminWipe.doneBackup'), { file: result?.backup_file ?? '' })}
      </p>
      {result?.files?.errors?.length > 0 && (
        <p className="text-footnote text-amber-400" role="status">{fill(t('adminWipe.doneFileErrors'), { n: result.files.errors.length })}</p>
      )}
      <p className="text-subheadline" data-testid="data-wipe-login-hint">
        {fill(t('adminWipe.doneLogin'), { name: result?.admin_username ?? '' })}
      </p>
      <button type="button" className="btn-primary w-full justify-center" data-testid="data-wipe-signout" onClick={onSignOut}>
        {t('adminWipe.signOut')}
      </button>
    </div>
  )
}

function errorText(error, t) {
  return error?.response?.data?.detail || error?.message || t('adminWipe.failed')
}

/** Settings > Administrator > Danger zone. */
export default function DataWipeCard() {
  const { t } = useSettings()
  const [state, setState] = useState({ phrase: '', password: '' })
  const [result, setResult] = useState(null)
  const preview = useQuery({ queryKey: ['admin-data-wipe-preview'], queryFn: getDataWipePreview, staleTime: 0, gcTime: 0, enabled: !result })
  const mutation = useMutation({
    mutationFn: () => runDataWipe(wipeRequest(state)),
    onSuccess: data => {
      // This device is already in step with the server; the result screen stays until the admin signs out.
      writeStoredEpoch(data.data_epoch)
      setResult(data)
    },
  })
  const change = patch => setState(prev => ({ ...prev, ...patch }))

  return (
    <section className="space-y-1" data-testid="data-wipe">
      <h2 className="px-4 pb-1.5 text-footnote text-red-400">{t('adminWipe.title')}</h2>
      <div className="space-y-4 overflow-hidden rounded-xl bg-card p-4">
        {result ? (
          <DataWipeResult result={result} t={t} onSignOut={() => wipeLocalData(result.data_epoch)} />
        ) : (
          <DataWipeForm
            preview={preview.data}
            state={{ ...state, busy: mutation.isPending }}
            onChange={change}
            onSubmit={() => mutation.mutate()}
            t={t}
            error={mutation.isError ? errorText(mutation.error, t) : preview.isError ? errorText(preview.error, t) : null}
          />
        )}
      </div>
    </section>
  )
}
