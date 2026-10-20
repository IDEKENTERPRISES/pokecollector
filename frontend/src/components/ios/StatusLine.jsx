import { useOffline } from '../../offline/useOffline'
import OfflineBanner from '../sync/OfflineBanner'
import StaleDataLabel, { useStaleDataText } from '../sync/StaleDataLabel'

/**
 * One compact line inside the sticky nav bar for "offline" and "showing saved data" (design doc
 * §6.6): "Offline · Showing saved data from 5 min ago", "Offline", or "Showing saved data from …".
 * It keeps role="status" and the test ids `offline-banner` (while offline) and `stale-data-label`
 * (on the saved-data text); the conditions are the old banner's and label's.
 */
export default function StatusLine() {
  const offline = useOffline()
  const stale = useStaleDataText()

  if (!offline && !stale) return null

  const line = offline
    ? <OfflineBanner><StaleDataLabel /></OfflineBanner>
    : <div role="status" className="flex min-w-0 items-center text-footnote"><StaleDataLabel /></div>

  return <div className="px-4 pb-2 pt-0.5">{line}</div>
}
