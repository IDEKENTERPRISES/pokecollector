import { wholePercent } from './goals'

/** A progress ring with the whole percent in the middle. Decorative: the text next to it says the same. */
export default function GoalRing({ percent = 0, size = 64, stroke = 7, label = true, className = '' }) {
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const fraction = Math.max(0, Math.min(1, (Number(percent) || 0) / 100))
  const complete = fraction >= 1
  return (
    <span className={`relative inline-grid flex-shrink-0 place-items-center ${className}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} strokeLinecap="round"
          stroke={complete ? 'var(--color-green)' : 'var(--color-tint, var(--color-yellow))'}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          className="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-500"
        />
      </svg>
      {label && (
        <span className="absolute font-display tabular-nums text-text-primary" style={{ fontSize: Math.max(11, size * 0.26) }}>
          {wholePercent(percent)}%
        </span>
      )}
    </span>
  )
}
