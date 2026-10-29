import { useEffect, useState } from 'react'
import { useSettings } from '../contexts/SettingsContext'
import { fill } from '../components/splash/format'
import { xpProgress } from './xp'

const prefersReducedMotion = () => (
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
)

/**
 * The trainer's level and the XP bar toward the next one (engagement P7). `info` is the server's
 * { xp, level, level_start, next_level_at }. The fill grows once when it appears and again when the
 * XP changes; with Reduce Motion it jumps straight to its width. `tone="onAccent"` is for the
 * trainer card's gradient.
 */
export default function XpBar({ info, tone = 'card', testId = 'xp-bar', className = '' }) {
  const { t } = useSettings()
  const progress = xpProgress(info)
  const percent = progress?.percent ?? 0
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? percent : 0))

  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(percent)
      return undefined
    }
    const frame = requestAnimationFrame(() => setShown(percent))
    return () => cancelAnimationFrame(frame)
  }, [percent])

  if (!progress) return null
  const onAccent = tone === 'onAccent'
  const amount = progress.maxed
    ? fill(t('today.xp'), { xp: info.xp })
    : fill(t('today.xpInto'), { into: progress.into, span: progress.span })
  const caption = progress.maxed
    ? t('today.topLevel')
    : fill(t('today.xpToNext'), { count: progress.remaining, level: progress.level + 1 })
  const label = `${fill(t('today.level'), { level: progress.level })}. ${caption}`

  return (
    <div className={className} data-testid={testId} data-level={progress.level} data-percent={progress.percent}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className={`text-footnote font-semibold ${onAccent ? '' : 'text-text-primary'}`}>
          {fill(t('today.level'), { level: progress.level })}
        </span>
        <span className={`text-footnote tabular-nums ${onAccent ? 'opacity-90' : 'text-text-secondary'}`}>{amount}</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={progress.maxed ? 1 : progress.span}
        aria-valuenow={progress.maxed ? 1 : progress.into}
        className={`relative h-2 overflow-hidden rounded-full ${onAccent ? 'bg-black/25' : 'bg-fill-tertiary'}`}
      >
        <span
          data-testid={`${testId}-fill`}
          className={`absolute inset-y-0 left-0 rounded-full motion-safe:transition-[width] motion-safe:duration-700 motion-safe:ease-out ${onAccent ? 'bg-white' : 'bg-tint'}`}
          style={{ width: `${shown}%` }}
        />
      </div>
      <p className={`mt-1 text-caption-1 ${onAccent ? 'opacity-85' : 'text-text-secondary'}`}>{caption}</p>
    </div>
  )
}
