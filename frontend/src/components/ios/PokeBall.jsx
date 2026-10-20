import { useId } from 'react'

/**
 * One Poké Ball SVG whose top half takes a colour (the theme accent by default). The Scan button,
 * the camera shutter, progress rings, the theme picker and the Pokédex "caught" mark all use it.
 * `gloss` adds a small highlight on the upper left. Decorative unless `label` is given.
 */
export default function PokeBall({ size = 24, top = 'var(--color-accent)', gloss = false, label, className = '' }) {
  const clipId = useId()
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <defs>
        <clipPath id={clipId}><circle cx="24" cy="24" r="22" /></clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect x="0" y="0" width="48" height="24" fill={top} />
        <rect x="0" y="24" width="48" height="24" fill="#F4F4F6" />
        <rect x="0" y="21.5" width="48" height="5" fill="#111114" />
      </g>
      <circle cx="24" cy="24" r="22" fill="none" stroke="#111114" strokeWidth="3" />
      <circle cx="24" cy="24" r="7" fill="#F4F4F6" stroke="#111114" strokeWidth="3" />
      <circle cx="24" cy="24" r="2.6" fill="#D8D8DE" />
      {gloss && <ellipse cx="14.5" cy="12.5" rx="5.5" ry="3" transform="rotate(-35 14.5 12.5)" fill="#fff" opacity="0.45" />}
    </svg>
  )
}
