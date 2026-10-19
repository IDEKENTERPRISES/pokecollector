import clsx from 'clsx'

const TONES = {
  red: 'bg-red text-white',
  yellow: 'bg-yellow text-black',
  green: 'bg-green text-black',
  blue: 'bg-blue text-white',
  accent: 'bg-accent text-on-accent',
  gray: 'bg-fill-secondary text-text-primary',
}

/**
 * Count badge: a capsule with a number (capped at `max`, shown as "99+"), or a plain dot.
 * Renders nothing for a zero or missing count unless `dot` is set.
 */
export default function Badge({ count, max = 99, tone = 'red', dot = false, className = '' }) {
  if (dot) {
    return <span aria-hidden="true" className={clsx('inline-block h-2.5 w-2.5 rounded-full', TONES[tone] ?? TONES.red, className)} />
  }
  const n = Number(count)
  if (!Number.isFinite(n) || n <= 0) return null
  return (
    <span
      className={clsx(
        'inline-flex h-[18px] min-w-[18px] flex-shrink-0 items-center justify-center rounded-full px-1.5',
        'text-caption-1 font-semibold leading-none tabular-nums',
        TONES[tone] ?? TONES.red,
        className,
      )}
    >
      {n > max ? `${max}+` : n}
    </span>
  )
}
