import { useMemo, useState } from 'react'
import { Navigate, useNavigate, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpDown, ChevronRight, Flame, Globe, Trophy } from 'lucide-react'
import { getLeaderboard } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { useAuth } from '../contexts/AuthContext'
import { useNavBar } from '../navigation/useNavBar'
import { typeVar } from '../components/ios/pokemon'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { CardIdentity } from '../components/card-system'
import { CardModal } from '../components/CardItem'
import ShowcaseStrip from '../delights/ShowcaseStrip'
import { readShowDaily, streakLabel } from '../progress/daily'
import { TrainerAvatar, countLabel, PODIUM_TYPES } from './socialParts'

const NAV_BAR = {}
const SORT_OPTIONS = ['xp', 'total_value', 'total_cards', 'unique_cards', 'sets_completed', 'pnl']
const SORT_LABEL_KEYS = {
  xp: 'level',
  total_value: 'value',
  total_cards: 'cards',
  unique_cards: 'uniqueCards',
  sets_completed: 'setsCompleted',
  pnl: 'pnl',
}

export default function Leaderboard() {
  const navigate = useNavigate()
  const { t, formatPrice, pricePrimaryField } = useSettings()
  const { multiUser, user: currentUser } = useAuth()
  const [sortBy, setSortBy] = useState('total_value')
  const [selectedCard, setSelectedCard] = useState(null)
  const [showDaily] = useState(() => readShowDaily())
  useNavBar(NAV_BAR)

  const { data = [], isLoading, error } = useQuery({
    queryKey: ['leaderboard', pricePrimaryField],
    queryFn: () => getLeaderboard({ price_field: pricePrimaryField }).then((response) => response.data),
  })

  const rows = useMemo(() => {
    return [...data].sort((a, b) => {
      const left = Number(a?.[sortBy] ?? 0)
      const right = Number(b?.[sortBy] ?? 0)
      if (right !== left) return right - left
      return Number(b?.total_value ?? 0) - Number(a?.total_value ?? 0)
    })
  }, [data, sortBy])

  if (!multiUser) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="page-container">
      <div className="relative overflow-hidden rounded-xl bg-card p-4">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,203,5,0.18),transparent_45%)]" />
        <div className="relative flex items-center gap-3">
          <Trophy size={28} className="flex-shrink-0 text-yellow" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h1 className="text-title-3 font-display font-bold text-text-primary">{t('leaderboard.title')}</h1>
            <p className="text-footnote text-text-secondary">{countLabel(t, 'leaderboard.trainerCount', rows.length)}</p>
          </div>
        </div>
        <div className="relative mt-3">
          <label htmlFor="leaderboard-sort" className="mb-1 block text-footnote text-text-secondary">{t('leaderboard.sortBy')}</label>
          <div className="relative">
            <ArrowUpDown size={14} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
            <select id="leaderboard-sort" className="select pl-9" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              {SORT_OPTIONS.map((key) => <option key={key} value={key}>{t(`leaderboard.${SORT_LABEL_KEYS[key]}`)}</option>)}
            </select>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, index) => <div key={index} className="skeleton h-28 rounded-xl" />)}
        </div>
      ) : error ? (
        <div className="card text-sm text-red" role="alert">{t('leaderboard.loadFailed')}</div>
      ) : rows.length === 0 ? (
        <div className="card text-center py-16 text-text-muted">{t('leaderboard.noTrainers')}</div>
      ) : (
        <ol className="space-y-3" aria-label={t('leaderboard.title')}>
          {rows.map((trainer, index) => {
            const rank = index + 1
            const bestCard = trainer.most_valuable_card
            const showcase = trainer.showcase ?? []
            const pnl = Number(trainer.pnl ?? 0)
            const positive = pnl >= 0
            const isSelf = trainer.user_id === currentUser?.id
            const podium = PODIUM_TYPES[rank]
            const value = formatPrice(trainer.total_value)
            // The flame follows this device's "Show streaks and quests" switch, like Home.
            const streak = showDaily ? Number(trainer.streak ?? 0) : 0
            // Rank, name, then score: the order VoiceOver reads the row in.
            const summary = [
              t('leaderboard.rankLabel').replace('{rank}', rank),
              trainer.username,
              t('leaderboard.levelShort').replace('{level}', trainer.level ?? 1),
              ...(streak > 0 ? [streakLabel(t, streak)] : []),
              `${t('leaderboard.value')} ${value}`,
            ].join(', ')
            const header = (
              <>
                <span
                  aria-hidden="true"
                  className="grid h-10 min-w-10 flex-shrink-0 place-items-center rounded-full bg-fill-tertiary text-headline font-display font-black"
                  style={podium ? {
                    background: `linear-gradient(to bottom, ${typeVar(podium, 'top')}, ${typeVar(podium, 'bottom')})`,
                    color: podium === 'lightning' ? '#1D1600' : '#fff',
                  } : undefined}
                >
                  {rank}
                </span>
                <TrainerAvatar avatarId={trainer.avatar_id} size={48} />
                <span className="min-w-0 flex-1 text-left">
                  <span className="block break-words text-headline text-text-primary">{trainer.username}</span>
                  <span className="block text-footnote text-text-secondary">{trainer.role}</span>
                </span>
                <span className="flex-shrink-0 rounded-full bg-fill-tertiary px-2 py-0.5 text-footnote font-semibold tabular-nums text-text-primary" data-testid="leaderboard-level">
                  {t('leaderboard.levelShort').replace('{level}', trainer.level ?? 1)}
                </span>
                {streak > 0 && (
                  <span
                    aria-hidden="true"
                    className="inline-flex flex-shrink-0 items-center gap-0.5 rounded-full bg-fill-tertiary px-2 py-0.5 text-footnote font-semibold tabular-nums text-yellow"
                    data-testid="leaderboard-streak"
                  >
                    <Flame size={14} />
                    {streak}
                  </span>
                )}
                <span className="flex-shrink-0 text-body font-semibold text-yellow tabular-nums">{value}</span>
                {!isSelf && <ChevronRight size={18} strokeWidth={2.25} className="flex-shrink-0 text-text-tertiary" aria-hidden="true" />}
              </>
            )
            return (
              <li key={trainer.user_id} className="overflow-hidden rounded-xl bg-card">
                {isSelf ? (
                  <div role="group" aria-label={summary} className="flex items-center gap-3 px-4 py-3">{header}</div>
                ) : (
                  <button
                    type="button"
                    onClick={() => navigate(`/leaderboard/compare/${trainer.user_id}`)}
                    aria-label={`${summary}. ${t('leaderboard.compareWith').replace('{name}', trainer.username)}`}
                    className="flex w-full items-center gap-3 px-4 py-3 active:bg-elevated"
                  >
                    {header}
                  </button>
                )}

                <dl className="grid grid-cols-3 gap-2 border-t border-border px-4 py-3 text-center">
                  <div>
                    <dt className="text-footnote text-text-secondary">{t('leaderboard.cards')}</dt>
                    <dd className="text-body font-semibold text-text-primary tabular-nums">{Number(trainer.total_cards ?? 0).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt className="text-footnote text-text-secondary">{t('leaderboard.setsCompleted')}</dt>
                    <dd className="text-body font-semibold text-text-primary tabular-nums">{Number(trainer.sets_completed ?? 0).toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt className="text-footnote text-text-secondary">{t('leaderboard.pnl')}</dt>
                    <dd className={`text-body font-semibold tabular-nums ${positive ? 'text-green' : 'text-red'}`}>
                      {positive ? '+' : ''}{formatPrice(pnl)}
                    </dd>
                  </div>
                </dl>

                {(bestCard || showcase.length > 0 || !isSelf || trainer.public_handle) && (
                  <div className="space-y-2 border-t border-border px-4 py-3">
                    {bestCard && (
                      <div>
                        <p className="mb-1 text-footnote text-text-secondary">{t('leaderboard.bestCard')}</p>
                        <CardIdentity
                          className="w-full max-w-full"
                          card={bestCard}
                          image={resolveCardImageUrl(bestCard)}
                          name={bestCard.name}
                          subtext={formatPrice(bestCard.price_market)}
                          onClick={() => setSelectedCard(bestCard)}
                        />
                      </div>
                    )}
                    <ShowcaseStrip cards={showcase} label={t('delights.showcase')} />
                    {(!isSelf || trainer.public_handle) && (
                      <div className="flex flex-wrap items-center gap-2">
                        {!isSelf && (
                          <button
                            type="button"
                            onClick={() => navigate(`/collection/user/${trainer.user_id}`)}
                            aria-label={t('leaderboard.openCollection').replace('{name}', trainer.username)}
                            className="ios-press inline-flex h-9 items-center rounded-full bg-fill-tertiary px-3 text-footnote font-semibold text-tint"
                          >
                            {t('leaderboard.viewCollection')}
                          </button>
                        )}
                        {trainer.public_handle && (
                          <Link
                            to={`/u/${trainer.public_handle}`}
                            aria-label={t('leaderboard.publicProfileOf').replace('{name}', trainer.username)}
                            className="ios-press inline-flex h-9 items-center gap-1.5 rounded-full bg-fill-tertiary px-3 text-footnote font-semibold text-tint"
                          >
                            <Globe size={14} aria-hidden="true" />
                            {t('leaderboard.viewPublicProfile')}
                          </Link>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {selectedCard && (
        <CardModal
          card={{ ...selectedCard, id: selectedCard.card_id || selectedCard.id }}
          onClose={() => setSelectedCard(null)}
        />
      )}
    </div>
  )
}
