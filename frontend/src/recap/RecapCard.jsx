import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { ChevronRight, Share2, Sparkles } from 'lucide-react'
import { getWeeklyRecap } from '../api/client'
import { maskValue, useHideValues } from '../components/ios/hideValues'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import { fill } from '../delights/delights'
import { readShowDaily } from '../progress/daily'
import { localDateString } from '../progress/checkin'
import { currentAccent, currentFont, renderBlocksImage, sharePicture } from '../progress/shareImage'
import { collectionItemTargetUrl } from '../utils/navigation'
import { RECAP_SHARE_FILE, hasRecap, recapShareSpec, signedAmount, weekRange } from './recap'

/**
 * Home's weekly recap card (engagement P9a), just under the Today card. The server decides when it
 * shows (Sunday 18:00 to Tuesday, local time) and whether the week had anything in it; the card
 * renders nothing otherwise, so it never leaves an empty slot. The query key carries the local date,
 * so a new day fetches again and the read cache serves it offline. The streak line follows the
 * "Show streaks and quests" switch; amounts are masked while hide-values is on.
 */
export default function RecapCard() {
  const { t, formatPrice, language: locale } = useSettings()
  const { user } = useAuth()
  const { hidden } = useHideValues()
  const picture = useRef(null)
  const { data } = useQuery({
    queryKey: ['weekly-recap', user?.id, localDateString()],
    queryFn: getWeeklyRecap,
    enabled: Boolean(user?.id),
    staleTime: 5 * 60 * 1000,
    retry: false,
  })
  if (!hasRecap(data)) return null

  const showStreak = readShowDaily()
  const money = amount => formatPrice(amount)
  const masked = amount => maskValue(money(amount), hidden)
  const { value, best_pull: best, closest_set: closest, streak, badges } = data

  const build = () => renderBlocksImage(recapShareSpec({
    data, t, money, showStreak, hideValues: hidden, locale: locale || undefined,
    accent: currentAccent(), fontFamily: currentFont(),
  }))
  // Draw on touch-down, so the share sheet opens inside the tap that follows.
  const prepare = () => { picture.current = picture.current || build() }
  const share = async () => {
    try {
      const blob = await (picture.current || build())
      picture.current = null
      if (!blob) {
        toast.error(t('recap.shareFailed'))
        return
      }
      if (await sharePicture(blob, { name: RECAP_SHARE_FILE }) === 'downloaded') toast.success(t('recap.shareDownloaded'))
    } catch {
      toast.error(t('recap.shareFailed'))
    }
  }

  return (
    <section aria-labelledby="recap-title" data-testid="weekly-recap" className="rounded-[22px] bg-surface p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <Sparkles size={20} className="text-tint" aria-hidden="true" />
        <h2 id="recap-title" className="text-title-3 font-display text-text-primary">{t('recap.title')}</h2>
      </div>
      <p className="mt-0.5 text-subheadline text-text-secondary">{weekRange(data, locale || undefined)}</p>

      <dl className="mt-3 grid grid-cols-2 gap-3">
        <div data-testid="recap-added">
          <dt className="text-footnote text-text-secondary">{t('recap.cardsAdded')}</dt>
          <dd className="text-title-2 font-display tabular-nums text-text-primary">{data.cards_added}</dd>
        </div>
        {value && value.change !== 0 && (
          <div data-testid="recap-value">
            <dt className="text-footnote text-text-secondary">{t('recap.valueChange')}</dt>
            <dd className="text-title-2 font-display tabular-nums text-text-primary">
              {maskValue(signedAmount(value.change, money(Math.abs(value.change))), hidden)}
            </dd>
          </div>
        )}
      </dl>

      {best && (
        <Link
          to={collectionItemTargetUrl(best)}
          data-testid="recap-best-pull"
          className="ios-press mt-3 flex min-h-[44px] items-center gap-3 focus-visible:outline-2 focus-visible:outline-tint"
        >
          <img src={best.image} alt="" loading="lazy" className="h-[84px] w-[60px] rounded-md bg-fill-tertiary object-cover" />
          <span className="min-w-0 flex-1">
            <span className="block text-footnote text-text-secondary">{t('recap.bestPull')}</span>
            <span className="block truncate text-callout font-semibold text-text-primary">{best.name}</span>
            <span className="block text-footnote tabular-nums text-text-secondary">{masked(best.price)}</span>
          </span>
          <ChevronRight size={18} className="text-text-secondary" aria-hidden="true" />
        </Link>
      )}

      {closest && (
        <Link
          to={`/sets/${encodeURIComponent(closest.set_id)}`}
          data-testid="recap-closest-set"
          className="ios-press mt-1 flex min-h-[44px] items-center justify-between gap-2 text-callout text-tint focus-visible:outline-2 focus-visible:outline-tint"
        >
          <span className="min-w-0 truncate">{fill(t('recap.closestSet'), { set: closest.name, missing: closest.missing })}</span>
          <ChevronRight size={18} aria-hidden="true" />
        </Link>
      )}

      {showStreak && streak?.current > 0 && (
        <p className="mt-1 text-subheadline text-text-secondary" data-testid="recap-streak">
          {fill(t('recap.streak'), { count: streak.current })}
        </p>
      )}
      {badges?.length > 0 && (
        <p className="mt-1 text-subheadline text-text-secondary" data-testid="recap-badges">
          {fill(t(badges.length === 1 ? 'recap.badgesOne' : 'recap.badges'), { count: badges.length })}
        </p>
      )}

      <button
        type="button"
        onPointerDown={prepare}
        onClick={share}
        className="ios-press mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-fill-tertiary text-callout font-semibold text-tint focus-visible:outline-2 focus-visible:outline-tint"
      >
        <Share2 size={18} aria-hidden="true" />
        {t('recap.share')}
      </button>
    </section>
  )
}
