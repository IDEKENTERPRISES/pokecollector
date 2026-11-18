import ScannerSettingsCard from './ScannerSettingsCard'

/**
 * Settings › Scanner while "Matcher only (no AI)" is on (docs/scanner-providers.md): the per-user scanner editor is
 * replaced, for everyone, by this short read-only card. Nobody's stored scanner settings are fetched, changed or
 * cleared; the editor is only hidden and comes back when the switch is turned off.
 */
export function MatcherOnlyScannerCard({ t, isAdmin }) {
  return (
    <div className="overflow-hidden rounded-xl bg-card" data-testid="matcher-only-scanner-card">
      <div role="status" className="space-y-1 px-4 py-4">
        <p className="text-sm font-semibold text-text-primary">{t('settings.matcherOnlyCardTitle')}</p>
        <p className="text-footnote text-text-secondary">{t('settings.matcherOnlyCardBody')}</p>
        {isAdmin && <p className="text-footnote text-text-secondary">{t('settings.matcherOnlyCardAdmin')}</p>}
      </div>
    </div>
  )
}

/** The scanner editor, or the read-only card while Matcher only is on (no scanner-config request is made then). */
export default function ScannerSetupSection({ t, matcherOnly, isAdmin }) {
  if (matcherOnly) return <MatcherOnlyScannerCard t={t} isAdmin={isAdmin} />
  return <ScannerSettingsCard t={t} />
}
