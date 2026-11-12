import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import { useSettings } from '../../contexts/SettingsContext'

export const BANNER_STYLES = ['info', 'success', 'warning', 'alert']
export const MAX_VISIBLE_BANNERS = 3

const ACCENTS = { info: '#3B82F6', success: '#22C55E', warning: '#F59E0B', alert: '#EF4444' }

export const spriteUrl = id => (id ? `/api/pokedex/images/sprites/${id}.png` : null)

/** The "and N more" count for a list of banners shown at most `MAX_VISIBLE_BANNERS` at a time. */
export function overflowCount(banners) {
  return Math.max(0, banners.length - MAX_VISIBLE_BANNERS)
}

/**
 * One banner card: round sprite, sender, a small Admin/System label and the message as plain text.
 * `onDismiss` shows the close button; `linkLabel` + `route` show the link (not in the admin preview).
 */
export default function BannerView({ banner, onDismiss, interactive = true, testId = 'banner-card' }) {
  const { t } = useSettings()
  const style = BANNER_STYLES.includes(banner.style) ? banner.style : 'info'
  const accent = ACCENTS[style]
  const sprite = spriteUrl(banner.avatar_id)
  const label = banner.label === 'system' ? t('banners.labelSystem') : t('banners.labelAdmin')

  return (
    <div
      role="status"
      data-testid={testId}
      data-style={style}
      className="relative overflow-hidden rounded-[18px] bg-card p-3 pr-3"
      style={{ boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${accent} 45%, transparent)` }}
    >
      <span aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ background: `color-mix(in srgb, ${accent} 14%, transparent)` }} />
      <div className="relative flex items-start gap-3">
        <span
          className="grid h-12 w-12 flex-shrink-0 place-items-center overflow-hidden rounded-full bg-black/80"
          style={{ boxShadow: `0 0 0 2px ${accent}` }}
        >
          {sprite && <img src={sprite} alt="" className="pixelated h-10 w-10" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 text-subheadline font-semibold text-text-primary">
            <span style={{ overflowWrap: 'anywhere' }} data-testid="banner-sender">{banner.sender_name}</span>
            <span
              className="rounded-full px-2 py-0.5 text-caption-2 font-bold uppercase tracking-wide text-text-primary"
              style={{ background: `color-mix(in srgb, ${accent} 28%, transparent)` }}
              data-testid="banner-label"
            >
              {label}
            </span>
          </p>
          <p className="mt-0.5 whitespace-pre-line text-footnote text-text-primary" style={{ overflowWrap: 'anywhere' }} data-testid="banner-message">
            {banner.message}
          </p>
          {banner.route && (
            interactive ? (
              <Link to={banner.route} className="ios-press mt-1.5 inline-block text-footnote font-semibold text-tint" data-testid="banner-link">
                {t('banners.open')}
              </Link>
            ) : (
              <span className="mt-1.5 inline-block text-footnote font-semibold text-tint" data-testid="banner-link">{t('banners.open')}</span>
            )
          )}
        </div>
        {onDismiss && banner.dismissible && (
          <button
            type="button"
            aria-label={t('banners.dismiss')}
            data-testid="banner-dismiss"
            onClick={() => onDismiss(banner)}
            className="ios-press -mr-1 -mt-1 grid h-11 w-11 flex-shrink-0 place-items-center rounded-full text-text-secondary"
          >
            <X size={18} />
          </button>
        )}
      </div>
    </div>
  )
}
