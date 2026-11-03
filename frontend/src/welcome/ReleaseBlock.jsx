import clsx from 'clsx'
import { useSettings } from '../contexts/SettingsContext'
import ReleaseIcon from './releaseIcons'
import { formatReleaseDate, releaseTitle } from './releases'

const ROW = 'relative flex items-center gap-3 px-4 py-[11px] min-h-[44px]'
// A hairline between rows, inset to the text like the artboards' `.row + .row::before`.
const SEPARATED = 'before:pointer-events-none before:absolute before:left-4 before:right-0 before:top-0 before:h-[0.5px] before:bg-border'

/** One group of the detail page: a footnote header over a card of rows. */
function Group({ header, items, small = false }) {
  if (!items?.length) return null
  return (
    <section>
      <h3 className="px-4 pb-1.5 text-footnote text-text-secondary">{header}</h3>
      <ul className="overflow-hidden rounded-xl bg-card">
        {items.map((text, index) => (
          <li key={text} className={clsx(ROW, index > 0 && SEPARATED)}>
            <p className={small ? 'text-footnote text-text-secondary' : 'text-subheadline'}>{text}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * A release as the What's new sheet and the version history show it (docs/WELCOME_DESIGN.md §4.3).
 * level 'highlights': the name, the date and up to three highlight rows. level 'details': the
 * New / Better / Fixed / Under the hood groups (empty ones left out).
 * `heading` is the highlights heading's tag (h3 in the sheet, h2 under "Coming next"); `first`
 * drops the top rule and padding; `date` replaces the formatted date (a draft has none).
 */
export default function ReleaseBlock({ release, level = 'highlights', heading: Heading = 'h3', first = false, date, className = '' }) {
  const { t } = useSettings()
  if (level === 'details') {
    const { details = {}, underTheHood = [] } = release
    return (
      <div className={clsx('flex flex-col gap-5', className)}>
        <Group header={t('welcome.groupNew')} items={details.new} />
        <Group header={t('welcome.groupBetter')} items={details.better} />
        <Group header={t('welcome.groupFixed')} items={details.fixed} />
        <Group header={t('welcome.groupHood')} items={underTheHood.slice(0, 5)} small />
      </div>
    )
  }
  const headingId = `rb-${release.id ?? release.name}`
  const when = date ?? formatReleaseDate(release)
  return (
    <section
      aria-labelledby={headingId}
      data-testid={`release-block-${release.id ?? 'next'}`}
      className={clsx('px-4 pb-1', first ? 'pt-2' : 'border-t-[0.5px] border-border pt-4', className)}
    >
      <Heading id={headingId} className="text-title-2 text-text-primary">
        {releaseTitle(release)}
        <span className="sr-only">, {when}</span>
      </Heading>
      <p className="text-footnote text-text-secondary" aria-hidden="true">{when}</p>
      <ul className="mt-2 flex flex-col gap-1">
        {release.highlights.map((item, index) => (
          <li
            key={item.title}
            className={clsx('relative flex min-h-[56px] items-start gap-3 py-[11px]', index > 0 && SEPARATED)}
          >
            <ReleaseIcon name={item.icon} />
            <span className="min-w-0 flex-1">
              <span className="block text-headline">{item.title}</span>
              <span className="block text-footnote text-text-secondary">{item.text}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
