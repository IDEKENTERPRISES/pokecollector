import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { CalendarHeart, ChevronRight } from 'lucide-react'
import { getOnThisDay } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import { localDateString } from '../progress/checkin'
import { collectionItemTargetUrl } from '../utils/navigation'
import { fill, hasOnThisDay } from './delights'

/**
 * Home's On this day card (engagement P8): cards acquired on today's month and day in earlier years.
 * It renders nothing until there is something to show, so it never leaves an empty slot. The query
 * key carries the local date, so a new day fetches again and the read cache serves it offline.
 * Each thumbnail opens that copy in the Collection.
 */
export default function OnThisDayCard() {
  const { t } = useSettings()
  const { user } = useAuth()
  const date = localDateString()
  const { data } = useQuery({
    queryKey: ['on-this-day', user?.id, date],
    queryFn: getOnThisDay,
    enabled: Boolean(user?.id),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
  if (!hasOnThisDay(data)) return null

  const title = fill(t(data.total === 1 ? 'delights.onThisDayTotalOne' : 'delights.onThisDayTotal'), { count: data.total })
  return (
    <section aria-labelledby="on-this-day-title" data-testid="on-this-day" className="rounded-[22px] bg-surface p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <CalendarHeart size={20} className="text-tint" aria-hidden="true" />
        <h2 id="on-this-day-title" className="text-title-3 font-display text-text-primary">{t('delights.onThisDay')}</h2>
      </div>
      <p className="mt-0.5 text-subheadline text-text-secondary">{title}</p>
      <ul className="mt-3 space-y-3">
        {data.years.map(group => (
          <li key={group.year} data-testid={`on-this-day-${group.year}`}>
            <p className="mb-1.5 flex items-baseline justify-between text-footnote">
              <span className="font-semibold text-text-primary tabular-nums">{group.year}</span>
              <span className="text-text-secondary">
                {fill(t(group.count === 1 ? 'delights.onThisDayYearOne' : 'delights.onThisDayYear'), { count: group.count })}
              </span>
            </p>
            <div className="flex gap-2">
              {group.cards.map(card => (
                <Link
                  key={card.item_id ?? card.card_id}
                  to={collectionItemTargetUrl(card)}
                  className="ios-press block aspect-[5/7] w-[22%] max-w-[84px] rounded-md focus-visible:outline-2 focus-visible:outline-tint"
                >
                  <img
                    src={card.image}
                    alt={card.name}
                    loading="lazy"
                    className="h-full w-full rounded-md bg-fill-tertiary object-cover"
                  />
                </Link>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <Link
        to="/collection?sort=acquired_at&order=asc"
        className="ios-press mt-3 flex min-h-[44px] items-center justify-between text-callout text-tint focus-visible:outline-2 focus-visible:outline-tint"
      >
        {t('delights.onThisDaySee')}
        <ChevronRight size={18} aria-hidden="true" />
      </Link>
    </section>
  )
}
