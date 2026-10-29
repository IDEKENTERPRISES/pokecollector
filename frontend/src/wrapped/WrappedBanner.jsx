import { Play } from 'lucide-react'
import Link from '../components/ios/TransitionLink'
import { useSettings } from '../contexts/SettingsContext'
import { fill } from '../delights/delights'
import { thousands, wrappedYearFor } from './wrapped'
import { useWrapped } from './useWrapped'

/**
 * Home's Wrapped banner (engagement P9b), under the shortcuts row. It renders nothing unless the API
 * says Wrapped is available (1 December to 15 January), so it never leaves an empty slot.
 */
export default function WrappedBanner() {
  const { t, language: locale } = useSettings()
  const { data } = useWrapped(wrappedYearFor())
  if (!data) return null
  const cards = data.totals?.cards ?? 0

  return (
    <Link
      to={`/wrapped/${data.year}`}
      data-testid="wrapped-banner"
      className="ios-press relative block min-h-[168px] overflow-hidden rounded-[22px] p-[18px] pb-4 text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tint"
      style={{ background: 'linear-gradient(135deg, #E3350D 0%, #8A3BA5 55%, #236BB4 100%)' }}
    >
      <span aria-hidden="true" className="absolute -right-9 -top-9 h-[170px] w-[170px] rounded-full border-[18px] border-white/15" />
      <span className="block text-[13px] font-bold uppercase tracking-[1.2px] opacity-90">{t('wrapped.bannerKicker')}</span>
      <span className="mt-1.5 block max-w-[190px] text-[28px] font-extrabold leading-[1.1] tracking-[-0.5px]">
        {fill(t('wrapped.bannerTitle'), { year: data.year })}
      </span>
      {cards > 0 && (
        <span className="mt-1.5 block max-w-[190px] text-[15px] opacity-90">
          {fill(t('wrapped.bannerLine'), { count: thousands(cards, locale || undefined) })}
        </span>
      )}
      <span className="mt-3 inline-flex min-h-[36px] items-center gap-1.5 rounded-full bg-white px-3.5 text-[15px] font-bold text-[#1C1C1E]">
        {t('wrapped.play')} <Play size={12} fill="#1C1C1E" aria-hidden="true" />
      </span>
    </Link>
  )
}
