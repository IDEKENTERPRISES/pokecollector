import { Compass, Smartphone } from 'lucide-react'
import { TodoCard } from '../pages/HomeScreen'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import { requestTour, useHomeNote } from './tourControl'
import { useTourActive } from './tourBus'
import { isNewAccount, recordTourDone, tourIsDone } from './tourStorage'

/**
 * "Take the tour" on Home for an account that has not finished or skipped it (docs/WELCOME_DESIGN.md §3.9): Home's own
 * TodoCard in the water type, with a quiet "Not now" under it that counts as done. A new account starts the tour by
 * itself instead, and single-user mode has no tour at all.
 */
export default function TakeTourCard() {
  const { user, multiUser, updateCurrentUser } = useAuth()
  const { t } = useSettings()
  const active = useTourActive()
  if (!multiUser || !user || active || tourIsDone(user) || isNewAccount(user)) return null

  return (
    <div data-tour="tour-card" data-testid="take-tour-card">
      <TodoCard
        type="water"
        icon={Compass}
        title={t('tour.cardTitle')}
        detail={t('tour.cardDetail')}
        action={t('tour.cardAction')}
        onClick={requestTour}
      />
      <button
        type="button"
        data-testid="take-tour-not-now"
        onClick={() => recordTourDone(user, 'dismissed', updateCurrentUser)}
        className="ios-press mx-auto block min-h-[44px] px-4 text-callout text-text-secondary"
      >
        {t('tour.cardNotNow')}
      </button>
    </div>
  )
}

/** After "I'll add it now": a line at the top of Home that says where to take the tour. */
export function HomeTourNote() {
  const { t } = useSettings()
  const { multiUser } = useAuth()
  const show = useHomeNote()
  if (!multiUser || !show) return null
  return (
    <p data-testid="tour-home-note" className="flex items-start gap-3 rounded-[18px] bg-card p-3 text-subheadline text-text-secondary">
      <Smartphone size={20} className="mt-px flex-shrink-0 text-tint" aria-hidden="true" />
      <span>{t('tour.homeNote')}</span>
    </p>
  )
}
