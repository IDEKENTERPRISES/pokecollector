import { useMemo, useState } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeftRight } from 'lucide-react'
import { compareUsers } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { useAuth } from '../contexts/AuthContext'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { CardIdentity } from '../components/card-system'
import { CardModal } from '../components/CardItem'
import HpBar from '../components/ios/HpBar'
import { useNavBar } from '../navigation/useNavBar'
import { TrainerAvatar, countLabel } from './socialParts'

function StatRow({ label, value, accent }) {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-3 px-4 py-2.5">
      <dt className="text-body text-text-primary">{label}</dt>
      <dd className={`text-body font-semibold tabular-nums ${accent || 'text-text-secondary'}`}>{value}</dd>
    </div>
  )
}

function TrainerPanel({ trainer, formatPrice, t, onCardClick }) {
  const pnl = Number(trainer?.pnl ?? 0)
  const bestCard = trainer?.most_valuable_card

  return (
    <section className="overflow-hidden rounded-xl bg-card" aria-label={trainer?.username}>
      <div className="flex items-center gap-3 p-4">
        <TrainerAvatar avatarId={trainer?.avatar_id} size={56} />
        <div className="min-w-0">
          <h2 className="truncate text-title-3 font-display font-bold text-text-primary">{trainer?.username}</h2>
          <p className="text-footnote text-text-secondary">{trainer?.role}</p>
        </div>
      </div>

      <dl className="divide-y divide-border border-t border-border">
        <StatRow label={t('leaderboard.value')} value={formatPrice(trainer?.total_value ?? 0)} accent="text-yellow" />
        <StatRow label={t('leaderboard.cards')} value={Number(trainer?.total_cards ?? 0).toLocaleString()} />
        <StatRow label={t('leaderboard.uniqueCards')} value={Number(trainer?.unique_cards ?? 0).toLocaleString()} />
        <StatRow label={t('leaderboard.setsCompleted')} value={Number(trainer?.sets_completed ?? 0).toLocaleString()} />
        <StatRow
          label={t('leaderboard.pnl')}
          value={`${pnl >= 0 ? '+' : ''}${formatPrice(pnl)}`}
          accent={pnl >= 0 ? 'text-green' : 'text-red'}
        />
      </dl>

      <div className="border-t border-border p-4">
        <p className="mb-2 text-footnote text-text-secondary">{t('leaderboard.bestCard')}</p>
        {bestCard ? (
          <CardIdentity
            className="w-full"
            card={bestCard}
            image={resolveCardImageUrl(bestCard)}
            name={bestCard.name}
            subtext={formatPrice(bestCard.price_market)}
            onClick={() => onCardClick(bestCard)}
          />
        ) : (
          <p className="text-body text-text-muted">-</p>
        )}
      </div>
    </section>
  )
}

const NAV_BAR = {}

export default function Compare() {
  const { userId } = useParams()
  useNavBar(NAV_BAR)
  const { t, formatPrice, pricePrimaryField } = useSettings()
  const { multiUser } = useAuth()
  const [selectedCard, setSelectedCard] = useState(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['compare', userId, pricePrimaryField],
    queryFn: () => compareUsers(userId, { price_field: pricePrimaryField }).then((response) => response.data),
    enabled: Boolean(userId),
  })

  const overlapRatio = useMemo(() => {
    const total = Number(data?.overlap ?? 0) + Number(data?.only_a ?? 0) + Number(data?.only_b ?? 0)
    if (!total) return 0
    return (Number(data?.overlap ?? 0) / total) * 100
  }, [data])

  if (!multiUser) {
    return <Navigate to="/" replace />
  }

  const suggestions = data?.trade_suggestions ?? []

  return (
    <div className="page-container">
      <div className="relative overflow-hidden rounded-xl bg-card p-4">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(42,117,187,0.28),transparent_45%)]" />
        <div className="relative">
          <h1 className="flex items-center gap-2 text-title-3 font-display font-bold text-text-primary">
            <ArrowLeftRight size={20} className="text-blue" aria-hidden="true" />
            {t('compare.title')}
          </h1>
          <p className="mt-1 text-footnote text-text-secondary">{t('leaderboard.compare')}</p>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, index) => <div key={index} className="skeleton h-48 rounded-xl" />)}
        </div>
      ) : error ? (
        <div className="card text-sm text-red" role="alert">{t('compare.loadFailed')}</div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-[1fr_320px_1fr]">
            <TrainerPanel trainer={data.user_a} formatPrice={formatPrice} t={t} onCardClick={setSelectedCard} />

            <section className="overflow-hidden rounded-xl bg-card lg:order-none">
              <div className="flex items-center justify-center gap-3 p-4" aria-hidden="true">
                <span className="grid h-20 w-20 place-items-center rounded-full bg-fill-tertiary text-title-2 font-display font-black text-blue shadow-[inset_0_0_0_1px_rgba(42,117,187,0.5)]">{data.only_a}</span>
                <span className="-mx-6 z-10 grid h-16 w-16 place-items-center rounded-full bg-card text-title-3 font-display font-black text-yellow shadow-[inset_0_0_0_1px_rgba(255,203,5,0.55)] backdrop-blur-xs">{data.overlap}</span>
                <span className="grid h-20 w-20 place-items-center rounded-full bg-fill-tertiary text-title-2 font-display font-black text-red shadow-[inset_0_0_0_1px_rgba(227,53,13,0.5)]">{data.only_b}</span>
              </div>
              <dl className="divide-y divide-border border-t border-border">
                <StatRow label={t('compare.cardsInCommon')} value={Number(data.overlap ?? 0).toLocaleString()} accent="text-yellow" />
                <StatRow label={t('compare.onlyA')} value={Number(data.only_a ?? 0).toLocaleString()} accent="text-blue" />
                <StatRow label={t('compare.onlyB')} value={Number(data.only_b ?? 0).toLocaleString()} accent="text-red" />
              </dl>
              <div className="space-y-1.5 border-t border-border p-4">
                <p className="text-footnote text-text-secondary">{t('compare.overlap')}</p>
                <HpBar value={overlapRatio} max={100} label={`${t('compare.overlap')} ${Math.round(overlapRatio)}%`} />
              </div>
            </section>

            <TrainerPanel trainer={data.user_b} formatPrice={formatPrice} t={t} onCardClick={setSelectedCard} />
          </div>

          <section className="rounded-xl bg-card p-4">
            <div className="mb-3">
              <h2 className="text-headline text-text-primary">{t('compare.tradeSuggestions')}</h2>
              <p className="text-footnote text-text-secondary">
                {t('compare.exclusiveCards')}
                {suggestions.length > 0 && ` · ${countLabel(t, 'compare.suggestionCount', suggestions.length)}`}
              </p>
            </div>

            {suggestions.length ? (
              <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {suggestions.map((trade) => (
                  <li key={`${trade.card_id}-${trade.owner_username}-${trade.wants_username}`} className="rounded-xl bg-fill-tertiary p-3">
                    <CardIdentity
                      className="w-full"
                      card={trade}
                      image={resolveCardImageUrl(trade)}
                      name={trade.card_name}
                      subtext={`${trade.owner_username} ${t('compare.has')} · ${trade.wants_username} ${t('compare.wants')}`}
                      onClick={() => setSelectedCard({ ...trade, id: trade.card_id, name: trade.card_name })}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl border border-dashed border-border p-6 text-center text-footnote text-text-muted">
                {t('compare.noTrades')}
              </p>
            )}
          </section>
        </>
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
