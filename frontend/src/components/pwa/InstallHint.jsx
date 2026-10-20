import { useState } from 'react'
import { Share } from 'lucide-react'
import { useSettings } from '../../contexts/SettingsContext'
import { isStandalone } from '../../offline/capabilities'
import { useOutbox } from '../../offline/useOutbox'

const DISMISS_KEY = 'pc.installHint.dismissed'

export function isIosDevice(nav = globalThis.navigator) {
  if (!nav) return false
  if (/iPhone|iPad|iPod/.test(nav.userAgent || '')) return true
  // iPadOS reports a Mac user agent but has a touch screen.
  return nav.platform === 'MacIntel' && nav.maxTouchPoints > 1
}

function readDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

/** "Add to Home Screen" card for iPhone/iPad Safari; `force` ignores the dismissal (the /offline page). */
export default function InstallHint({ force = false }) {
  const { t } = useSettings()
  const { enabled, items } = useOutbox()
  const [dismissed, setDismissed] = useState(readDismissed)

  if (!enabled || isStandalone() || !isIosDevice() || (dismissed && !force)) return null

  const dismiss = () => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // dismissal just lasts until reload
    }
  }

  return (
    <aside data-testid="install-hint" className="mx-4 my-3 flex items-start gap-3 rounded-xl bg-card p-4 text-subheadline">
      <Share size={20} className="mt-0.5 flex-shrink-0 text-tint" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-headline text-text-primary">{t('pwa.installTitle')}</p>
        <p className="text-text-secondary">{t('pwa.installSteps')}</p>
        {items.length > 0 && <p className="text-footnote text-yellow">{t('sync.syncBeforeInstall')}</p>}
      </div>
      {!force && (
        <button type="button" className="ios-press min-h-[44px] shrink-0 rounded-full px-3 text-callout text-tint" onClick={dismiss}>{t('pwa.installDismiss')}</button>
      )}
    </aside>
  )
}
