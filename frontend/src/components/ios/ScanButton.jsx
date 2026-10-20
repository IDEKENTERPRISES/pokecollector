import { useSettings } from '../../contexts/SettingsContext'
import PokeBall from './PokeBall'

/**
 * The Scan circle in the middle of the tab bar (design doc §6.2, Q17): a 60 px Poké Ball whose top
 * half is the theme accent, raised so it overlaps the capsule's top edge by 16 px, with the label
 * "Scan" on the label row. A yellow count badge at the top right, a yellow pulse ring while jobs
 * process (static under reduced motion) and a white ring while the scan inbox is open.
 */
export default function ScanButton({ badge = 0, active = false, processing = false, onPress }) {
  const { t } = useSettings()
  const label = badge > 0
    ? t('nav.scanAttention').replace('{count}', String(badge))
    : processing ? t('nav.scanProcessing') : t('nav.scan')

  return (
    <div className="relative h-full">
      <button
        type="button"
        onClick={onPress}
        aria-label={label}
        data-testid="scan-button"
        data-active={active ? 'true' : 'false'}
        data-processing={processing ? 'true' : 'false'}
        className="ios-press absolute -top-4 left-1/2 h-[60px] w-[60px] -translate-x-1/2 rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tint"
        style={{
          boxShadow: active
            ? '0 0 0 3px #fff, 0 6px 16px rgba(0,0,0,0.5)'
            : '0 6px 16px rgba(0,0,0,0.5)',
        }}
      >
        {processing && (
          <span
            aria-hidden="true"
            data-testid="scan-pulse"
            className="absolute -inset-1 rounded-full border-[3px] border-yellow motion-safe:animate-ping motion-reduce:opacity-70"
          />
        )}
        <PokeBall size={60} gloss />
        {badge > 0 && (
          <span
            data-testid="scan-badge"
            className="absolute -right-1 -top-1 flex h-[20px] min-w-[20px] items-center justify-center rounded-full bg-yellow px-1 text-caption-1 font-bold leading-none text-black tabular-nums"
          >
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </button>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-[5px] text-center font-display text-caption-2 font-medium text-text-secondary"
      >
        {t('nav.scan')}
      </span>
    </div>
  )
}
