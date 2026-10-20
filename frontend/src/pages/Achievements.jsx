import { Navigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Award } from 'lucide-react'
import { getAchievements } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import { useNavBar } from '../navigation/useNavBar'
import HpBar from '../components/ios/HpBar'
import { TrainerAvatar } from './socialParts'

const NAV_BAR = {}

export default function Achievements() {
  const { userId } = useParams()
  const { user, multiUser } = useAuth()
  const { t, pricePrimaryField } = useSettings()
  useNavBar(NAV_BAR)
  const activeUserId = userId || user?.id

  const { data, isLoading, error } = useQuery({
    queryKey: ['achievements', activeUserId, pricePrimaryField],
    queryFn: () => getAchievements(activeUserId, { price_field: pricePrimaryField }).then((response) => response.data),
    enabled: Boolean(activeUserId),
  })

  if (!multiUser) {
    return <Navigate to="/" replace />
  }

  const earned = Number(data?.earned ?? 0)
  const total = Number(data?.total ?? 20)
  const earnedLabel = t('achievements.earnedCount').replace('{earned}', earned).replace('{total}', total)

  return (
    <div className="page-container">
      <div className="relative overflow-hidden rounded-xl bg-card p-4">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,203,5,0.18),transparent_45%)]" />
        <div className="relative flex items-center gap-3">
          <TrainerAvatar avatarId={data?.avatar_id || user?.avatar_id} size={56} />
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 text-title-3 font-display font-bold text-text-primary">
              <Award size={22} className="flex-shrink-0 text-yellow" aria-hidden="true" />
              {t('achievements.title')}
            </h1>
            <p className="truncate text-footnote text-text-secondary">{data?.username || user?.username}</p>
          </div>
        </div>
        {data && (
          <div className="relative mt-3 space-y-1.5">
            <p className="text-footnote font-semibold text-yellow">{earnedLabel}</p>
            <HpBar value={earned} max={total} label={earnedLabel} />
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[...Array(6)].map((_, index) => <div key={index} className="skeleton h-40 rounded-xl" />)}
        </div>
      ) : error ? (
        <div className="card text-sm text-red" role="alert">{t('achievements.loadFailed')}</div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.achievements.map((achievement) => {
            const progress = Number(achievement.progress ?? 0)
            const target = Number(achievement.target ?? 1)
            const name = t(achievement.name_key)
            const status = achievement.unlocked ? t('achievements.earned') : t('achievements.locked')
            return (
              <li
                key={achievement.id}
                className={`rounded-xl bg-card p-4 ${achievement.unlocked ? 'shadow-[inset_0_0_0_1px_rgba(255,203,5,0.45),0_0_24px_rgba(255,203,5,0.1)]' : ''}`}
              >
                <div className="flex items-start gap-3">
                  <img
                    src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/badges/${achievement.badge_id}.png`}
                    alt=""
                    aria-hidden="true"
                    className={`h-14 w-14 flex-shrink-0 object-contain ${achievement.unlocked ? '' : 'grayscale opacity-50'}`}
                    loading="lazy"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <h2 className="text-headline text-text-primary">{name}</h2>
                      <span className={`badge flex-shrink-0 ${achievement.unlocked ? 'badge-yellow' : 'badge-gray'}`}>{status}</span>
                    </div>
                    <p className="mt-1 text-footnote text-text-secondary">{t(achievement.description_key)}</p>
                  </div>
                </div>

                <div className="mt-3 space-y-1.5">
                  <div className="flex items-center justify-between text-footnote text-text-secondary">
                    <span>{t('achievements.progress')}</span>
                    <span className="tabular-nums">{progress}/{target}</span>
                  </div>
                  <HpBar
                    value={Math.min(progress, target)}
                    max={target}
                    label={`${name}: ${t('achievements.progressLabel').replace('{progress}', progress).replace('{target}', target)}`}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
