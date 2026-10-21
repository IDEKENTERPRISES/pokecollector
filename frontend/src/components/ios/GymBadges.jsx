import Link from './TransitionLink'
import { ChevronRight } from 'lucide-react'
import { TYPE_COLOURS, TYPE_KEYS } from './pokemon'

const BADGE_COUNT = 8
// Eight of the type palette, one per badge, so a row reads like a gym badge case.
const BADGE_TYPES = ['fire', 'water', 'grass', 'lightning', 'psychic', 'fighting', 'dragon', 'fairy']

/**
 * A row of eight hexagonal gym badges, coloured when earned. `earned` is a number (the first n
 * badges are lit) or an array of booleans for the first eight achievements. `total` is the whole
 * achievement count shown as "n/total"; with `to` the count is a link ("n/20 ›").
 */
export default function GymBadges({ earned = 0, total = 20, to, label }) {
  const flags = Array.isArray(earned)
    ? Array.from({ length: BADGE_COUNT }, (_, i) => Boolean(earned[i]))
    : Array.from({ length: BADGE_COUNT }, (_, i) => i < Number(earned))
  const earnedCount = Array.isArray(earned) ? earned.filter(Boolean).length : Math.min(Number(earned) || 0, total)

  const count = (
    <span className="flex items-center gap-0.5 text-footnote font-semibold tabular-nums">
      {earnedCount}/{total}
      {to && <ChevronRight size={14} strokeWidth={2.5} aria-hidden="true" />}
    </span>
  )

  return (
    <div className="flex items-center justify-between gap-2" role="group" aria-label={label}>
      <ul className="flex items-center gap-1.5" role="list">
        {flags.map((on, index) => {
          const key = BADGE_TYPES[index] ?? TYPE_KEYS[index]
          const colours = TYPE_COLOURS[key]
          return (
            <li key={index} data-earned={on}>
              <svg width="24" height="26" viewBox="0 0 24 26" aria-hidden="true" focusable="false">
                <path
                  d="M12 1.5l9.5 5.5v12L12 24.5 2.5 19V7z"
                  fill={on ? `var(--type-${key})` : 'rgba(255,255,255,0.14)'}
                  stroke={on ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.22)'}
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
                {on && <circle cx="12" cy="13" r="3.2" fill={colours.text} opacity="0.9" />}
              </svg>
            </li>
          )
        })}
      </ul>
      {to ? <Link to={to} className="ios-press text-inherit">{count}</Link> : count}
    </div>
  )
}
