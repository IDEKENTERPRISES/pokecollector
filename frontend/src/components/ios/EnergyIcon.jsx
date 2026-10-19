import { TYPE_COLOURS, typeKeyFor } from './pokemon'

// One simple, generic glyph per type on a 24×24 grid. Not the official energy artwork.
const GLYPHS = {
  grass: <path d="M6.5 17.5C6 10 10.5 5.5 18 5.5c.5 7.5-4 12-11.5 12zm0 0L13 11" fill="currentColor" stroke="none" />,
  fire: <path d="M12 3.5c.8 3.2 5.5 5.2 5.5 9.7a5.5 5.5 0 0 1-11 0c0-2 .9-3.3 2.2-4.3.1 1.8.9 2.8 2 3 0-3-1.2-5.4 1.3-8.4z" fill="currentColor" />,
  water: <path d="M12 3.5c3.3 4.2 5.6 6.9 5.6 10a5.6 5.6 0 0 1-11.2 0c0-3.1 2.3-5.8 5.6-10z" fill="currentColor" />,
  lightning: <path d="M13.5 3 6.5 13.2h4.7L10.2 21l7.3-10.7h-4.8z" fill="currentColor" />,
  psychic: <path fillRule="evenodd" d="M2.8 12c2.4-4 5.5-6.2 9.2-6.2s6.8 2.2 9.2 6.2c-2.4 4-5.5 6.2-9.2 6.2S5.2 16 2.8 12zM12 9.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z" fill="currentColor" />,
  fighting: (
    <g fill="currentColor">
      <rect x="6.5" y="10" width="11" height="8" rx="3" />
      <circle cx="8.3" cy="9" r="1.9" /><circle cx="12" cy="8.2" r="1.9" /><circle cx="15.7" cy="9" r="1.9" />
    </g>
  ),
  darkness: <path d="M15.5 4a8 8 0 1 0 4.8 12.6A7 7 0 0 1 15.5 4z" fill="currentColor" />,
  metal: <path d="M12 3.8l6.8 3.9v8.6L12 20.2l-6.8-3.9V7.7z" fill="currentColor" />,
  dragon: (
    <g fill="currentColor">
      <path d="M7 5c2.5 3 3 8 .8 14 3.8-2.4 5.7-7.4 4.4-14z" />
      <path d="M12.5 5c2.5 3 3 8 .8 14 3.8-2.4 5.7-7.4 4.4-14z" opacity="0.85" />
    </g>
  ),
  fairy: <path d="M12 3c.9 5 2 6.1 7 9-5 2.9-6.1 4-7 9-.9-5-2-6.1-7-9 5-2.9 6.1-4 7-9z" fill="currentColor" />,
  colorless: <path d="M12 3.6l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z" fill="currentColor" />,
}

/** An energy symbol: a simple glyph in white (dark on Lightning and Colorless) on a circle of the type's colour. */
export default function EnergyIcon({ type, size = 20, className = '' }) {
  const key = typeKeyFor(type) ?? 'colorless'
  const { solid, text } = TYPE_COLOURS[key]
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
      style={{ color: text }}
    >
      <circle cx="12" cy="12" r="12" fill={`var(--type-${key}, ${solid})`} />
      <g transform="translate(3.6 3.6) scale(0.7)">{GLYPHS[key]}</g>
    </svg>
  )
}
