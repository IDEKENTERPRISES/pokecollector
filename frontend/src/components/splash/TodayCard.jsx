import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight } from 'lucide-react'
import { useSettings } from '../../contexts/SettingsContext'
import { HOME_FACTS, UNITS } from './config'
import { localDate, readDay, splashLanguage } from './entryStore'
import { factLabelKey, splashText, typeColour } from './format'
import { ensureDay } from './prefetch'

/**
 * Home's "Pokémon of the day": the same Pokémon and facts as today's splash, from the device when
 * it was fetched ahead. Tapping it never closes anything, so it may link to the species' cards.
 */
export default function TodayCard() {
  const { t, language } = useSettings()
  const lang = splashLanguage(language)
  const date = localDate()
  const { data: entry } = useQuery({
    queryKey: ['pokemon-of-the-day', date, lang],
    queryFn: async () => (await ensureDay(date, { language: lang })) ?? null,
    initialData: () => {
      const stored = readDay(date)
      return stored?.lang === lang ? stored : undefined
    },
    staleTime: 6 * 60 * 60 * 1000,
    retry: 1,
  })
  if (!entry) return null

  const text = splashText(entry, { t, language, units: UNITS })
  const light = 'color-mix(in srgb, var(--today-type) 70%, #fff)'
  return (
    <section aria-labelledby="pokemon-of-the-day" className="space-y-2" data-testid="pokemon-of-the-day">
      <h2 id="pokemon-of-the-day" className="px-1 text-title-3 text-text-primary">{t('splash.todayTitle')}</h2>
      <div className="relative isolate overflow-hidden rounded-[22px] bg-card" style={{ '--today-type': typeColour(entry.types) }}>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-12 -top-14 -z-10 h-52 w-52 rounded-full opacity-40"
          style={{ background: 'radial-gradient(closest-side, var(--today-type), transparent)' }}
        />
        <div className="flex items-center gap-4 p-4">
          <img
            src={entry.sprite_url}
            alt=""
            width="88"
            height="88"
            loading="lazy"
            className="h-[88px] w-[88px] flex-shrink-0 object-contain"
            style={entry.sprite_style === 'pixel' ? { imageRendering: 'pixelated' } : undefined}
          />
          <div className="min-w-0 flex-1">
            <p className="text-footnote tabular-nums text-text-secondary">
              {text.number}
              {entry.shiny && <span className="ml-2 text-[#ffd94a]">★ {t('splash.shiny')}</span>}
            </p>
            <p className="break-words font-display text-title-2 text-text-primary">{entry.name}</p>
            <p className="text-footnote text-text-secondary">{text.meta}</p>
            <p className="text-footnote tabular-nums text-text-secondary">
              {[text.height && `${t('splash.height')} ${text.height}`, text.weight && `${t('splash.weight')} ${text.weight}`]
                .filter(Boolean)
                .map(line => <span key={line} className="block">{line}</span>)}
            </p>
          </div>
        </div>
        {entry.facts.length > 0 && (
          <ul className="space-y-3 border-t-[0.5px] border-border px-4 py-3">
            {entry.facts.slice(0, HOME_FACTS).map(fact => (
              <li key={`${fact.kind}-${fact.title ?? ''}`}>
                <p className="text-caption-1 font-semibold" style={{ color: light }}>{t(factLabelKey(fact.kind))}</p>
                <p className="text-subheadline text-text-secondary">
                  {fact.title && <strong className="font-semibold text-text-primary">{fact.title}: </strong>}
                  {fact.text}
                </p>
              </li>
            ))}
          </ul>
        )}
        <Link
          to={`/pokedex/${entry.dex_id}`}
          className="flex min-h-[44px] items-center justify-between border-t-[0.5px] border-border px-4 text-body text-tint ios-press"
        >
          {t('splash.todayCards')}
          <ChevronRight size={18} aria-hidden="true" />
        </Link>
      </div>
    </section>
  )
}
