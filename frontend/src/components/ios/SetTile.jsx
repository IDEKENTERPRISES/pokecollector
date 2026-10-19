import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { useSettings } from '../../contexts/SettingsContext'
import HpBar from './HpBar'
import { TileArtwork } from './SeriesTile'

/**
 * Set tile for a series page or the plain sets grid (design doc §5.4): the set logo over a spotlight
 * in colourFor(set.id), the name, the set code, "owned / total" with an HP bar, a yellow
 * "Releases <date>" strip when `upcoming` is set and a green Complete badge when every card is owned.
 *
 * set: { id, name, logo, abbreviation, releaseLabel }; `upcoming` is true for unreleased sets.
 */
export default function SetTile({ set, owned = 0, total = 0, upcoming = false, complete = false, to, className = '' }) {
  const { t } = useSettings()
  const classes = clsx(
    'no-callout block overflow-hidden rounded-[18px] bg-card text-left',
    to && 'ios-press focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tint',
    className,
  )
  const body = (
    <>
      <TileArtwork logo={set.logo} name={set.name} colourKey={set.id} />
      {upcoming && set.releaseLabel && (
        <div className="bg-yellow px-3 py-1 text-center text-caption-1 font-semibold text-black">
          {t('ios.releases').replace('{date}', set.releaseLabel)}
        </div>
      )}
      <div className="space-y-1.5 p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 truncate text-headline text-text-primary">{set.name}</p>
          {complete && (
            <span className="inline-flex items-center rounded-full bg-green px-2 py-0.5 text-caption-1 font-semibold leading-none text-black">
              {t('ios.complete')}
            </span>
          )}
        </div>
        {set.abbreviation && <p className="truncate text-caption-1 text-text-secondary">{set.abbreviation}</p>}
        <HpBar value={owned} max={total} label={set.name} />
        <p className="text-caption-1 tabular-nums text-text-secondary">
          {t('ios.ownedOfTotal').replace('{owned}', owned).replace('{total}', total)}
        </p>
      </div>
    </>
  )
  return to ? <Link to={to} className={classes}>{body}</Link> : <div className={classes}>{body}</div>
}
