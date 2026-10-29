import { useQuery } from '@tanstack/react-query'
import { Flame } from 'lucide-react'
import { getTodaySummary } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import { localDate } from '../components/splash/entryStore'
import { fill } from '../components/splash/format'
import { streakLabel } from './daily'

/**
 * A compact flame and day count beside "Hello, <name>" on Home (engagement P7). Tapping it brings the
 * Today card into view. Nothing shows at a streak of 0; Home renders it only when "Show streaks and
 * quests" is on. It reads the same query as the Today card, so it costs no extra request.
 */
export default function GreetingStreak() {
  const { t } = useSettings()
  const { user } = useAuth()
  const userId = user?.id
  const date = localDate()
  const { data: summary } = useQuery({
    queryKey: ['today-card', userId, date],
    queryFn: () => getTodaySummary(date),
    enabled: typeof userId === 'number',
    staleTime: 30 * 1000,
    retry: false,
  })
  const count = summary?.streak?.current ?? 0
  if (count <= 0) return null

  const show = () => {
    const calm = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    document.getElementById('today-card')?.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' })
  }
  return (
    <button
      type="button"
      onClick={show}
      aria-label={fill(t('today.streakGo'), { label: streakLabel(t, count) })}
      data-testid="greeting-streak"
      data-streak={count}
      className="ios-press inline-flex min-h-[44px] flex-shrink-0 items-center gap-1 rounded-full bg-fill-tertiary px-3 text-headline font-semibold tabular-nums text-yellow"
    >
      <Flame size={20} aria-hidden="true" />
      {count}
    </button>
  )
}
