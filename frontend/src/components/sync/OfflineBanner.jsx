import { CloudOff } from 'lucide-react'
import { useSettings } from '../../contexts/SettingsContext'
import { useOffline } from '../../offline/useOffline'

/** Strip at the top of the layout once the server has been unreachable twice or the device says offline. */
export default function OfflineBanner() {
  const { t } = useSettings()
  const offline = useOffline()

  if (!offline) return null

  return (
    <div
      role="status"
      data-testid="offline-banner"
      className="flex items-start gap-2 border-b border-yellow/30 bg-yellow/10 pb-2 pl-4 pr-20 text-xs text-text-primary sm:text-sm"
      style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
    >
      <CloudOff size={16} className="mt-0.5 flex-shrink-0 text-yellow" aria-hidden />
      <p className="min-w-0 flex-1 leading-snug">{t('sync.offlineBanner')}</p>
    </div>
  )
}
