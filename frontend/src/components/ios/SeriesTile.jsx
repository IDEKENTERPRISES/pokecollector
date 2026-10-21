import { useEffect, useState } from 'react'
import Link from './TransitionLink'
import clsx from 'clsx'
import { useSettings } from '../../contexts/SettingsContext'
import HpBar from './HpBar'
import { colourFor } from './pokemon'

function CompleteBadge({ label }) {
  return (
    <span className="inline-flex items-center rounded-full bg-green px-2 py-0.5 text-caption-1 font-semibold leading-none text-black">
      {label}
    </span>
  )
}

/**
 * An image that walks down `sources` when one fails to load and shows `fallback` (the item's name)
 * when none does, so a failed logo is never a blank.
 */
export function FallbackImage({ sources, fallback, alt = '', className, fallbackClassName }) {
  const key = sources.join('|')
  const [failed, setFailed] = useState(0)
  useEffect(() => setFailed(0), [key])
  const src = sources[failed]
  return src
    ? <img src={src} alt={alt} loading="lazy" onError={() => setFailed(count => count + 1)} className={className} />
    : <span className={fallbackClassName}>{fallback}</span>
}

/** Logo area over a spotlight in the item's colour. Shared by SeriesTile and SetTile. */
export function TileArtwork({ logo, logoSources, name, colourKey, className = '' }) {
  const type = colourFor(colourKey ?? name)
  return (
    <div
      className={clsx('relative grid h-[88px] place-items-center overflow-hidden rounded-t-[18px] px-3', className)}
      style={{
        background: `radial-gradient(ellipse 80% 90% at 50% 45%, color-mix(in srgb, var(--type-${type}) 55%, transparent), color-mix(in srgb, var(--type-${type}-bottom) 80%, #000) 85%)`,
      }}
    >
      <FallbackImage
        sources={logoSources ?? (logo ? [logo] : [])}
        fallback={name}
        className="max-h-[64px] max-w-full object-contain drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]"
        fallbackClassName="text-title-3 font-display text-center text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]"
      />
    </div>
  )
}

/**
 * Series tile for the Sets grid (design doc §5.4): logo over a spotlight in colourFor(series.key),
 * the name, years and set count, the cards owned of all cards in the series with an HP bar, and a
 * green Complete badge when the series is done.
 *
 * series: { key, name, logo, years, setCount }; owned and total are card counts.
 */
export default function SeriesTile({ series, owned = 0, total = 0, complete = false, to, className = '' }) {
  const { t } = useSettings()
  const classes = clsx(
    'no-callout block overflow-hidden rounded-[18px] bg-card text-left',
    to && 'ios-press focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tint',
    className,
  )
  const body = (
    <>
      <TileArtwork logo={series.logo} logoSources={series.logoCandidates} name={series.name} colourKey={series.key} />
      <div className="space-y-1.5 p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 truncate text-headline text-text-primary">{series.name}</p>
          {complete && <CompleteBadge label={t('ios.complete')} />}
        </div>
        <p className="truncate text-caption-1 text-text-secondary">
          {[series.years, series.setCount != null ? t('ios.setsCount').replace('{count}', series.setCount) : null].filter(Boolean).join(' · ')}
        </p>
        <HpBar value={owned} max={total} label={series.name} />
        <p className="text-caption-1 tabular-nums text-text-secondary">
          {t('ios.ownedOfTotal').replace('{owned}', owned).replace('{total}', total)}
        </p>
      </div>
    </>
  )
  return to ? <Link to={to} className={classes}>{body}</Link> : <div className={classes}>{body}</div>
}
