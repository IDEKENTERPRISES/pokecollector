import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { BookMarked, ExternalLink, Heart, Pin, PinOff } from 'lucide-react'
import { addGoalMissingToWishlist, getGoal, getGoalWishlistPreview, makeGoalBinder, updateGoal } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useConfirmDialog } from '../contexts/ConfirmDialogContext'
import { useSettings } from '../contexts/SettingsContext'
import { useNavBar } from '../navigation/useNavBar'
import { CardModal } from '../components/CardItem'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { cardmarketLinks } from '../utils/cardmarket'
import GoalRing from '../goals/GoalRing'
import { KIND_LABEL_KEYS, goalPercent, goalQueryKey, isGoalComplete } from '../goals/goals'

function MissingRow({ card, onOpen, formatPrice, t }) {
  const market = cardmarketLinks(card, card.variant)[0]
  return (
    <li className="flex items-center gap-1 border-t-[0.5px] border-border first:border-t-0" data-testid={`goal-missing-${card.card_id}`}>
      <button type="button" onClick={() => onOpen(card)} className="ios-press flex min-h-[64px] min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left">
        <img
          src={resolveCardImageUrl(card, 'small')}
          alt=""
          loading="lazy"
          className="h-14 w-10 flex-shrink-0 rounded-[4px] bg-fill object-cover"
        />
        <span className="min-w-0 flex-1">
          <span className="block break-words text-body text-text-primary">{card.name}</span>
          <span className="block text-footnote text-text-secondary">
            {[card.set_id, card.number ? `#${card.number}` : null, card.variant, card.lang?.toUpperCase()].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className="flex-shrink-0 text-body tabular-nums text-text-primary">
          {card.price != null ? formatPrice(card.price) : t('goals.noPrice')}
        </span>
      </button>
      {market?.url && (
        <a
          href={market.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('goals.openCardmarket').replace('{name}', card.name)}
          className="ios-press mr-1 grid h-11 w-11 flex-shrink-0 place-items-center text-tint"
        >
          <ExternalLink size={18} aria-hidden="true" />
        </a>
      )}
    </li>
  )
}

export default function GoalDetail() {
  const { goalId } = useParams()
  const { user } = useAuth()
  const { t, formatPrice } = useSettings()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const confirm = useConfirmDialog()
  const [selected, setSelected] = useState(null)

  const queryKey = goalQueryKey(user?.id, goalId)
  const { data: goal, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => getGoal(goalId),
    enabled: Boolean(user?.id),
    retry: false,
  })
  const progress = goal?.progress
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['goals'] })
    queryClient.invalidateQueries({ queryKey: ['goal'] })
  }

  const pinMutation = useMutation({
    mutationFn: () => updateGoal(goal.id, { pinned: !goal.pinned }),
    onSuccess: refresh,
    onError: () => toast.error(t('goals.saveFailed')),
  })
  const wishlistMutation = useMutation({
    mutationFn: () => addGoalMissingToWishlist(goal.id),
    onSuccess: result => {
      toast.success(t('goals.wishlistAdded').replace('{count}', result.added))
      queryClient.invalidateQueries({ queryKey: ['wishlist'] })
    },
    onError: () => toast.error(t('goals.wishlistFailed')),
  })
  const binderMutation = useMutation({
    mutationFn: () => makeGoalBinder(goal.id),
    onSuccess: result => {
      toast.success(t('goals.binderMade').replace('{name}', result.name))
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      navigate(`/binders/${result.binder_id}`)
    },
    onError: () => toast.error(t('goals.binderFailed')),
  })

  const addToWishlist = async () => {
    try {
      const { to_add: count } = await getGoalWishlistPreview(goal.id)
      if (!count) {
        toast(t('goals.wishlistNothing'))
        return
      }
      const ok = await confirm({
        title: t('goals.wishlistTitle'),
        message: t('goals.wishlistConfirm').replace('{count}', count),
        confirmLabel: t('goals.wishlistAction'),
        destructive: false,
      })
      if (ok) wishlistMutation.mutate()
    } catch {
      toast.error(t('goals.wishlistFailed'))
    }
  }

  const navBar = useMemo(() => ({ title: goal?.title ?? t('goals.title') }), [goal?.title, t])
  useNavBar(navBar)

  const percent = goalPercent(goal)
  const complete = isGoalComplete(goal)
  const shown = progress?.cheapest_missing || []
  const kindLabel = goal ? t(KIND_LABEL_KEYS[goal.kind]) : ''
  const busy = wishlistMutation.isPending || binderMutation.isPending
  const stats = useMemo(() => progress && [
    { id: 'owned', label: t('goals.owned'), value: `${progress.owned} / ${progress.total}` },
    { id: 'missing', label: t('goals.missing'), value: String(progress.missing) },
  ], [progress, t])

  if (isLoading) return <div className="skeleton h-48 rounded-2xl" />
  if (error || !goal) {
    return <div className="card text-sm text-red" role="alert" data-testid="goal-missing">{t('goals.notFound')}</div>
  }

  return (
    <div className="space-y-4 pb-4">
      <section className="rounded-[22px] bg-card p-4" aria-labelledby="goal-title" data-testid="goal-summary">
        <div className="flex items-center gap-4">
          <GoalRing percent={percent} size={96} stroke={9} />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-caption-1 font-semibold uppercase tracking-wide text-tint">{kindLabel}</p>
            <h1 id="goal-title" className="break-words text-title-2 font-display text-text-primary">{goal.title}</h1>
            <p className="text-footnote tabular-nums text-text-secondary">
              {t('goals.ownedOfTotal').replace('{owned}', progress.owned).replace('{total}', progress.total)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => pinMutation.mutate()}
            aria-pressed={Boolean(goal.pinned)}
            aria-label={goal.pinned ? t('goals.unpin') : t('goals.pin')}
            className="ios-press grid h-11 w-11 flex-shrink-0 place-items-center self-start text-tint"
          >
            {goal.pinned ? <Pin size={20} aria-hidden="true" /> : <PinOff size={20} className="text-text-secondary" aria-hidden="true" />}
          </button>
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-3">
          {stats.map(stat => (
            <div key={stat.id}>
              <dt className="text-footnote text-text-secondary">{stat.label}</dt>
              <dd className="text-headline tabular-nums text-text-primary">{stat.value}</dd>
            </div>
          ))}
          <div data-testid="goal-cost">
            <dt className="text-footnote text-text-secondary">{t('goals.costToFinish')}</dt>
            <dd className="text-headline tabular-nums text-text-primary">{complete ? '–' : formatPrice(progress.cost_to_finish)}</dd>
          </div>
        </dl>
        {progress.unpriced_missing > 0 && (
          <p className="mt-2 text-footnote text-text-secondary">{t('goals.unpriced').replace('{count}', progress.unpriced_missing)}</p>
        )}
        {goal.completed_at && complete && <p className="mt-2 text-footnote font-semibold text-green">{t('goals.complete')}</p>}
      </section>

      {!complete && (
        <div className="grid grid-cols-2 gap-2">
          <button type="button" disabled={busy} onClick={addToWishlist} className="btn-secondary flex min-h-[44px] items-center justify-center gap-2 disabled:opacity-40" data-testid="goal-wishlist">
            <Heart size={16} aria-hidden="true" />{t('goals.wishlistAction')}
          </button>
          <button type="button" disabled={busy} onClick={() => binderMutation.mutate()} className="btn-secondary flex min-h-[44px] items-center justify-center gap-2 disabled:opacity-40" data-testid="goal-binder">
            <BookMarked size={16} aria-hidden="true" />{t('goals.binderAction')}
          </button>
        </div>
      )}

      {shown.length > 0 && (
        <section aria-labelledby="goal-missing-title" className="space-y-1.5">
          <h2 id="goal-missing-title" className="px-1 text-headline text-text-primary">{t('goals.cheapestMissing')}</h2>
          <ul className="overflow-hidden rounded-xl bg-card">
            {shown.map(card => (
              <MissingRow key={`${card.card_id}-${card.variant || ''}`} card={card} onOpen={setSelected} formatPrice={formatPrice} t={t} />
            ))}
          </ul>
          {progress.missing > shown.length && (
            <p className="px-1 text-footnote text-text-secondary">
              {t('goals.showingCheapest').replace('{shown}', shown.length).replace('{missing}', progress.missing)}
            </p>
          )}
        </section>
      )}

      {selected && <CardModal key={selected.id} card={selected} defaultLang={selected.lang} initialTab="overview" onClose={() => setSelected(null)} />}
    </div>
  )
}
