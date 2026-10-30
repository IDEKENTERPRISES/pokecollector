import { Link } from 'react-router-dom'
import { Target } from 'lucide-react'
import { useSettings } from '../contexts/SettingsContext'
import GoalRing from './GoalRing'
import { goalPercent, isGoalComplete, wholePercent } from './goals'

/** A pinned goal as a ring card in Home's "Your sets & goals" row (next to the set tiles). */
export default function GoalHomeCard({ goal }) {
  const { t, formatPrice } = useSettings()
  const complete = isGoalComplete(goal)
  const percent = goalPercent(goal)
  const cost = Number(goal.progress?.cost_to_finish) || 0
  return (
    <Link
      to={`/goals/${goal.id}`}
      data-testid={`goal-card-${goal.id}`}
      aria-label={`${goal.title}: ${wholePercent(percent)}%`}
      className="no-callout ios-press flex h-full flex-col gap-2 overflow-hidden rounded-[18px] bg-card p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tint"
    >
      <p className="flex items-center gap-1 text-caption-1 font-semibold uppercase tracking-wide text-tint">
        <Target size={12} aria-hidden="true" />{t('goals.badge')}
      </p>
      <div className="flex items-center gap-3">
        <GoalRing percent={percent} size={64} />
        <p className="min-w-0 break-words text-headline text-text-primary">{goal.title}</p>
      </div>
      <p className="text-caption-1 tabular-nums text-text-secondary">
        {complete
          ? t('goals.complete')
          : cost > 0
            ? t('goals.toFinish').replace('{amount}', formatPrice(cost))
            : t('goals.ownedOfTotal').replace('{owned}', goal.progress?.owned ?? 0).replace('{total}', goal.progress?.total ?? 0)}
      </p>
    </Link>
  )
}
