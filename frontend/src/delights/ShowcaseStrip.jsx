import { useSettings } from '../contexts/SettingsContext'
import { maskValue, useHideValues } from '../components/ios/hideValues'

/**
 * The Showcase 6 on the trainer card and on the public profile: up to six card images in a grid.
 * `cards` come from the API (id, name, image, set_name, variant, market_value); a value shows only
 * when the API sent one. Nothing renders for an empty showcase.
 */
export default function ShowcaseStrip({ cards = [], showValues = false, label, onCard }) {
  const { t, formatCompactPrice } = useSettings()
  const hidden = useHideValues()
  if (!cards.length) return null
  return (
    <div data-testid="showcase-strip">
      <p className="mb-1.5 text-caption-1 font-semibold uppercase tracking-wide opacity-85">{label ?? t('delights.showcase')}</p>
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {cards.map(card => (
          <li key={card.id} data-testid="showcase-card" className="min-w-0">
            <img
              src={card.image}
              alt={card.name}
              loading="lazy"
              className="aspect-[5/7] w-full rounded-md bg-black/20 object-cover"
              onClick={onCard ? () => onCard(card) : undefined}
            />
            {showValues && card.market_value != null && (
              <p className="mt-0.5 truncate text-center text-caption-2 tabular-nums opacity-90">
                {maskValue(formatCompactPrice(card.market_value), hidden)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
