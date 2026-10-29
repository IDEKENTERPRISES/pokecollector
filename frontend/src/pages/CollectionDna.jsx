import { useQuery } from '@tanstack/react-query'
import { getCollectionDna } from '../api/client'
import { TYPE_COLOURS, typeKeyFor } from '../components/ios/pokemon'
import { arcPath, barWidths, donutSegments, fill } from '../delights/delights'
import { useSettings } from '../contexts/SettingsContext'


const solidFor = type => TYPE_COLOURS[typeKeyFor(type) ?? 'colorless'].solid

function Section({ title, children, testId }) {
  return (
    <section className="rounded-[22px] bg-card p-4" data-testid={testId}>
      <h2 className="mb-3 text-title-3 font-display text-text-primary">{title}</h2>
      {children}
    </section>
  )
}

function Bars({ rows, labelOf, t, tone }) {
  return (
    <ul className="space-y-2">
      {barWidths(rows).map(row => (
        <li key={labelOf(row)} className="min-w-0">
          <div className="flex items-baseline justify-between gap-3 text-subheadline">
            <span className="min-w-0 truncate text-text-primary">{labelOf(row)}</span>
            <span className="flex-shrink-0 tabular-nums text-text-secondary">{fill(t('delights.dnaCount'), { count: row.count })}</span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-fill-tertiary" aria-hidden="true">
            <div className="h-2 rounded-full" style={{ width: `${row.width}%`, background: tone }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

function TypeWheel({ types, t }) {
  const segments = donutSegments(types)
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <svg viewBox="0 0 120 120" role="img" aria-label={t('delights.dnaTypesLabel')} className="h-40 w-40 flex-shrink-0">
        {segments.map(segment => (
          <path
            key={segment.type}
            d={arcPath(segment.start, segment.end)}
            fill={solidFor(segment.type)}
            stroke="var(--color-card)"
            strokeWidth="1"
          />
        ))}
      </svg>
      <ul className="grid w-full grid-cols-2 gap-x-4 gap-y-1">
        {segments.map(segment => (
          <li key={segment.type} className="flex min-h-[28px] items-center gap-2 text-subheadline">
            <span
              aria-hidden="true"
              className="h-3 w-3 flex-shrink-0 rounded-full border border-border"
              style={{ background: solidFor(segment.type) }}
            />
            <span className="min-w-0 flex-1 truncate capitalize text-text-primary">{segment.type}</span>
            <span className="tabular-nums text-text-secondary">{Math.round(segment.share * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Collection DNA (engagement P8): type wheel, top illustrators, eras and most-collected Pokémon. */
export default function CollectionDna() {
  const { t } = useSettings()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['collection-dna'],
    queryFn: getCollectionDna,
    retry: false,
  })

  return (
    <div className="space-y-4 px-4 pb-6" data-testid="collection-dna">
      <header className="pt-2">
        <h1 className="sr-only">{t('delights.dna')}</h1>
        <p className="text-subheadline text-text-secondary">{t('delights.dnaSubtitle')}</p>
      </header>
      {isLoading && <p className="text-body text-text-secondary">{t('common.loading')}</p>}
      {isError && !data && <p className="text-body text-text-secondary">{t('delights.dnaFailed')}</p>}
      {data && data.total_cards === 0 && <p className="text-body text-text-secondary">{t('delights.dnaEmpty')}</p>}
      {data && data.total_cards > 0 && (
        <>
          <p className="text-footnote text-text-secondary">{fill(t('delights.dnaTotal'), { count: data.total_cards })}</p>
          {data.types.length > 0 && <Section title={t('delights.dnaTypes')} testId="dna-types"><TypeWheel types={data.types} t={t} /></Section>}
          {data.illustrators.length > 0 && (
            <Section title={t('delights.dnaIllustrators')} testId="dna-illustrators">
              <Bars rows={data.illustrators} labelOf={row => row.name} t={t} tone="var(--color-tint)" />
            </Section>
          )}
          {data.eras.length > 0 && (
            <Section title={t('delights.dnaEras')} testId="dna-eras">
              <Bars rows={data.eras} labelOf={row => String(row.year)} t={t} tone="var(--color-accent)" />
            </Section>
          )}
          {data.pokemon.length > 0 && (
            <Section title={t('delights.dnaPokemon')} testId="dna-pokemon">
              <ul className="space-y-1">
                {data.pokemon.map(row => (
                  <li key={row.dex_id} className="flex min-h-[44px] items-center gap-3">
                    <img src={`/api/pokedex/images/sprites/${row.dex_id}.png`} alt="" width={40} height={40} className="h-10 w-10 flex-shrink-0 object-contain" />
                    <span className="min-w-0 flex-1 truncate text-body text-text-primary">{row.name}</span>
                    <span className="tabular-nums text-text-secondary">{fill(t('delights.dnaCount'), { count: row.count })}</span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
    </div>
  )
}
