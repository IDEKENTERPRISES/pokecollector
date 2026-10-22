import { CloudOff } from 'lucide-react'
import { useSettings } from '../contexts/SettingsContext'
import { useNotSaved } from '../offline/notSaved'
import { useServingFromCardDb } from '../offline/carddb/serving'
import { useOffline } from '../offline/useOffline'

/**
 * Offline, on a page that was never opened while online: one short line above its normal empty state
 * (design: every page opens offline; this replaces the full-page "isn't available offline").
 */
export default function NotSavedNote() {
  const { t } = useSettings()
  const offline = useOffline()
  const notSaved = useNotSaved()
  const fromCardDb = useServingFromCardDb()
  if (!offline || !notSaved || fromCardDb) return null

  return (
    <p
      role="status"
      data-testid="not-saved-note"
      className="mx-4 mb-3 mt-1 flex items-center gap-2 rounded-xl bg-card px-3.5 py-2.5 text-footnote text-text-secondary"
    >
      <CloudOff size={16} className="flex-shrink-0 text-yellow" aria-hidden="true" />
      {t('sync.notSavedYet')}
    </p>
  )
}
