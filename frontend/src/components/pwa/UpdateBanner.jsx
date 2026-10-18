import { useSyncExternalStore } from 'react'
import { useSettings } from '../../contexts/SettingsContext'
import { applyUpdate } from '../../pwa/register'
import { updateStore } from '../../pwa/updateStore'

// Non-blocking bar shown when a new service worker is waiting. Nothing activates on its own.
export default function UpdateBanner() {
  const { t } = useSettings()
  const { registration, blocked } = useSyncExternalStore(updateStore.subscribe, updateStore.getSnapshot)

  if (!registration) return null

  const handleUpdate = () => {
    const result = applyUpdate(registration)
    updateStore.setBlocked(result.blocked)
  }

  return (
    <div
      role="status"
      data-testid="update-banner"
      className="fixed inset-x-0 bottom-0 z-[60] flex justify-center px-4"
      style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)' }}
    >
      <div className="flex w-full max-w-md items-center gap-3 rounded-xl border border-border bg-bg-secondary px-4 py-3 shadow-xl">
        <div className="min-w-0 flex-1 text-sm text-text-primary">
          <p>{t('pwa.updateAvailable')}</p>
          {blocked && <p className="text-xs text-text-muted">{t('pwa.updateBlocked')}</p>}
        </div>
        <button type="button" onClick={handleUpdate} className="btn-primary shrink-0">
          {t('pwa.updateNow')}
        </button>
      </div>
    </div>
  )
}
