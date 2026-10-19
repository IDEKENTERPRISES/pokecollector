import clsx from 'clsx'
import { hpFraction, hpTone } from './pokemon'

const TONE_VAR = { green: 'var(--color-green)', yellow: 'var(--color-yellow)', red: 'var(--color-red)' }

/**
 * Completion shown as a Pokémon HP bar: 8 px, rounded; green above 50 %, yellow from 20 % to 50 %,
 * red below 20 %. `value` of `max`; an accessible progressbar named by `label`.
 */
export default function HpBar({ value, max, label, className = '' }) {
  const fraction = hpFraction(value, max)
  const tone = hpTone(value, max)
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Number(max) || 0}
      aria-valuenow={Math.round(Number(value) || 0)}
      data-tone={tone}
      className={clsx('h-2 w-full overflow-hidden rounded-full bg-black/45', className)}
      style={{ boxShadow: 'inset 0 0 0 0.5px rgba(255,255,255,0.12)' }}
    >
      <div
        className="h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500"
        style={{ width: `${fraction * 100}%`, background: TONE_VAR[tone] }}
      />
    </div>
  )
}
