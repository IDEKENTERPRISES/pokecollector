import { TIER_TINT, TRACK_TYPE } from '../../progress/achievements'
import { TYPE_COLOURS } from './pokemon'

const GLYPHS = {
  // Simple strokes inside the hexagon, 24 x 24 box.
  collection: 'M7 6h10v12H7z M9 9h6',
  sets: 'M12 5l2.2 4.6 5 .7-3.6 3.5.9 5L12 16.4 7.5 18.8l.9-5L4.8 10.300l5-.7z',
  value: 'M12 5v14 M15.500 8.500c-.8-1-2-1.500-3.500-1.500-2 0-3.500 1-3.500 2.500S10 12 12 12s3.500 1 3.500 2.500S14 17 12 17c-1.500 0-2.700-.5-3.500-1.500',
  pokedex: 'M12 5a7 7 0 100 14 7 7 0 000-14z M5 12h14 M12 10a2 2 0 100 4 2 2 0 000-4z',
  variety: 'M12 4l1.800 5.200L19 11l-5.200 1.800L12 18l-1.800-5.200L5 11l5.200-1.800z',
  explorer: 'M12 5a5 5 0 015 5c0 4-5 9-5 9s-5-5-5-9a5 5 0 015-5z M12 8.500a1.500 1.500 0 100 3 1.500 1.500 0 000-3z',
  trader: 'M6 9h11 M14 6l3 3-3 3 M18 15H7 M10 12l-3 3 3 3',
  daily: 'M12 4c1 3 4 4.500 4 8a4 4 0 01-8 0c0-1.500.6-2.600 1.500-3.500C9.600 10 10 8 12 4z',
}

/**
 * A gym badge: a hexagon in the track's type colour with a tier ring (bronze, silver, gold).
 * `holo` adds a static foil sheen; nothing here animates by itself, so Reduce Motion needs no case.
 */
export default function BadgeMedal({ track = 'collection', tier = 'bronze', earned = true, holo = false, size = 56, label }) {
  const type = TRACK_TYPE[track] ?? 'grass'
  const colours = TYPE_COLOURS[type]
  const ring = TIER_TINT[tier] ?? TIER_TINT.bronze
  const glyph = GLYPHS[track] ?? GLYPHS.collection
  const id = `medal-${track}-${tier}-${holo ? 'h' : 'p'}`
  return (
    <svg
      width={size}
      height={Math.round(size * 1.08)}
      viewBox="0 0 48 52"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      focusable="false"
      data-track={track}
      data-tier={tier}
      data-earned={earned}
      style={earned ? undefined : { filter: 'grayscale(1)', opacity: 0.45 }}
    >
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={colours.top} />
          <stop offset="1" stopColor={colours.bottom} />
        </linearGradient>
        {holo && (
          <linearGradient id={`${id}-foil`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ff4fa8" stopOpacity="0.55" />
            <stop offset="0.35" stopColor="#ffe44f" stopOpacity="0.4" />
            <stop offset="0.65" stopColor="#4fffb4" stopOpacity="0.45" />
            <stop offset="1" stopColor="#4fa8ff" stopOpacity="0.55" />
          </linearGradient>
        )}
      </defs>
      <path d="M24 2.500l20 11.500v24L24 49.500 4 38V14z" fill={`url(#${id}-fill)`} stroke={ring} strokeWidth="3" strokeLinejoin="round" />
      {holo && <path d="M24 2.500l20 11.500v24L24 49.500 4 38V14z" fill={`url(#${id}-foil)`} style={{ mixBlendMode: 'screen' }} />}
      <path d="M24 8l15.500 9v18L24 44 8.500 35V17z" fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="1" />
      <g transform="translate(12 14)" fill="none" stroke={colours.text} strokeWidth="1.900" strokeLinecap="round" strokeLinejoin="round">
        <path d={glyph} />
      </g>
    </svg>
  )
}
