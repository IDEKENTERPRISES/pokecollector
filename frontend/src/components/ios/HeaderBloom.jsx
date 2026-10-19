import { typeKeyFor } from './pokemon'

const VARIANTS = {
  home: ['var(--color-accent)', 'var(--poke-yellow)'],
  collection: ['var(--poke-blue)', 'var(--color-accent)'],
  search: ['var(--poke-blue)', 'var(--poke-yellow)'],
}

/**
 * Static radial glow behind a tab root's header, about 380 px tall (design doc §7.12). It is masked
 * so it starts black under the status bar (no seam) and fades back to black below. Place it first
 * inside a `relative isolate` page wrapper (it sits at z-index -1); it scrolls with the content and is never animated.
 *
 * variant 'home' | 'collection' | 'search', or `colour` (an energy-type name such as the result of
 * colourFor(), or any CSS colour) for a series page or Set detail.
 */
export default function HeaderBloom({ variant = 'home', colour }) {
  let first
  let second
  if (colour) {
    const key = typeKeyFor(colour)
    first = key ? `var(--type-${key})` : colour
    second = first
  } else {
    ;[first, second] = VARIANTS[variant] ?? VARIANTS.home
  }
  const mask = 'linear-gradient(to bottom, transparent 0, #000 96px, #000 45%, transparent 100%)'
  return (
    <div
      aria-hidden="true"
      data-testid="header-bloom"
      className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[380px] overflow-hidden"
      style={{
        background: [
          `radial-gradient(ellipse 70% 60% at 22% 18%, color-mix(in srgb, ${first} 42%, transparent), transparent 70%)`,
          `radial-gradient(ellipse 65% 55% at 82% 8%, color-mix(in srgb, ${second} 34%, transparent), transparent 72%)`,
        ].join(', '),
        WebkitMaskImage: mask,
        maskImage: mask,
      }}
    />
  )
}
