import { CloudOff } from 'lucide-react'
import { useSettings } from '../../contexts/SettingsContext'
import { useOffline } from '../../offline/useOffline'

/**
 * The offline line, rendered by StatusLine under the nav bar (design doc §6.6) once the server has
 * been unreachable twice or the device says offline. `children` (the saved-data text) sit on the
 * same line. The full sentence stays available as the title and to screen readers.
 */
export default function OfflineBanner({ children }) {
  const { t } = useSettings()
  const offline = useOffline()

  if (!offline) return null

  return (
    <div
      role="status"
      data-testid="offline-banner"
      title={t('sync.offlineBanner')}
      className="flex min-w-0 items-center gap-1.5 text-footnote text-text-primary"
    >
      <CloudOff size={14} className="flex-shrink-0 text-yellow" aria-hidden />
      <span className="sr-only">{t('sync.offlineBanner')}</span>
      <span aria-hidden="true" className="flex-shrink-0 font-semibold">{t('sync.offlineShort')}</span>
      {children}
    </div>
  )
}
