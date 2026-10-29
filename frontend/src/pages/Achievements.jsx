import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Award } from 'lucide-react'
import { getAchievements } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import { useNavBar } from '../navigation/useNavBar'
import BadgeMedal from '../components/ios/BadgeMedal'
import HpBar from '../components/ios/HpBar'
import { groupByTrack, tierLabelKey, trackLabelKey } from '../progress/achievements'
import { TrainerAvatar } from './socialParts'

const NAV_BAR = {}

function AchievementCard({ achievement, t }) {
  const progress = Number(achievement.progress ?? 0)
  const target = Number(achievement.target ?? 1)
  const shown = Math.min(progress, target)
  const name = t(achievement.name_key)
  const status = achievement.unlocked ? t('achievements.earned') : t('achievements.locked')
  const unlockedOn = achievement.unlocked && achievement.unlocked_at
    ? t('achievements.unlockedOn').replace('{date}', new Date(achievement.unlocked_at).toLocaleDateString())
    : null
  return (
    <li
      data-testid={`achievement-${achievement.id}`}
      className={`rounded-xl bg-card p-4 ${achievement.unlocked ? 'shadow-[inset_0_0_0_1px_rgba(255,203,5,0.45),0_0_24px_rgba(255,203,5,0.1)]' : ''}`}
    >
      <div className="flex items-start gap-3">
        <span className="flex-shrink-0">
          <BadgeMedal track={achievement.track} tier={achievement.tier} earned={Boolean(achievement.unlocked)} size={52} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-headline text-text-primary">{name}</h3>
            <span className={`badge flex-shrink-0 ${achievement.unlocked ? 'badge-yellow' : 'badge-gray'}`}>{status}</span>
          </div>
          <p className="mt-0.5 text-caption-1 font-semibold uppercase tracking-wide text-text-secondary">{t(tierLabelKey(achievement.tier))}</p>
          <p className="mt-1 text-footnote text-text-secondary">{t(achievement.description_key)}</p>
        </div>
      </div>

      <div className="mt-3 space-y-1.5">
        <div className="flex items-center justify-between text-footnote text-text-secondary">
          <span>{unlockedOn ?? t('achievements.progress')}</span>
          <span className="tabular-nums">{shown}/{target}</span>
        </div>
        <HpBar
          value={shown}
          max={target}
          label={`${name}: ${t('achievements.progressLabel').replace('{progress}', shown).replace('{target}', target)}`}
        />
      </div>
    </li>
  )
}

export default function Achievements() {
  const { userId } = useParams()
  const { user } = useAuth()
  const { t, pricePrimaryField } = useSettings()
  useNavBar(NAV_BAR)
  const activeUserId = userId || user?.id

  const { data, isLoading, error } = useQuery({
    queryKey: ['achievements', activeUserId, pricePrimaryField],
    queryFn: () => getAchievements(activeUserId, { price_field: pricePrimaryField }).then((response) => response.data),
    enabled: Boolean(activeUserId),
  })

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
            <p className="break-words text-footnote text-text-secondary">{data?.username || user?.username}</p>
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
        <div className="space-y-5">
          {groupByTrack(data.achievements).map(({ track, items }) => {
            const heading = t(trackLabelKey(track))
            return (
              <section key={track} aria-label={heading} data-testid={`track-${track}`} className="space-y-2">
                <h2 className="flex items-baseline justify-between px-1 text-headline text-text-primary">
                  {heading}
                  <span className="text-footnote font-normal tabular-nums text-text-secondary">
                    {items.filter(item => item.unlocked).length}/{items.length}
                  </span>
                </h2>
                <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {items.map(achievement => <AchievementCard key={achievement.id} achievement={achievement} t={t} />)}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
