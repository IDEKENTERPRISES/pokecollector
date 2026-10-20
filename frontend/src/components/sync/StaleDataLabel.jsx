import { createContext, useContext } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Clock } from 'lucide-react'
import { useSettings } from '../../contexts/SettingsContext'
import { useOutbox } from '../../offline/useOutbox'

/** When the data restored from the read cache was saved (ms), or null. Provided by OfflineProvider. */
export const SavedAtContext = createContext(null)
export const useSavedAt = () => useContext(SavedAtContext)

/** The saved-data text ("Showing saved data from 5 min ago") while the server is not reachable (D10), or null. */
export function useStaleDataText() {
  const { t } = useSettings()
  const savedAt = useSavedAt()
  const { enabled, reachability } = useOutbox()

  if (!enabled || !savedAt || reachability.state === 'reachable') return null
  return `${t('sync.staleData')} ${formatDistanceToNow(savedAt, { addSuffix: true })}`
}

/** "Showing saved data from …", shown inside the status line under the nav bar. */
export default function StaleDataLabel() {
  const text = useStaleDataText()
  if (!text) return null

  return (
    <span data-testid="stale-data-label" className="flex min-w-0 items-center gap-1 text-text-secondary">
      <Clock size={13} className="flex-shrink-0" aria-hidden />
      <span className="truncate">{text}</span>
    </span>
  )
}
