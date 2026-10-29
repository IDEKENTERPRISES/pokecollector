import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Check, ChevronRight, Pin, PinOff, Plus, Target, Trash2 } from 'lucide-react'
import {
  createGoal, deleteGoal, getBinderCards, getBinders, getGoalOptions, getGoals, getSets, searchCards, updateGoal,
} from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useConfirmDialog } from '../contexts/ConfirmDialogContext'
import { useSettings } from '../contexts/SettingsContext'
import { useNavBar } from '../navigation/useNavBar'
import ListRow from '../components/ios/ListRow'
import ListSection from '../components/ios/ListSection'
import PageSheet from '../components/ios/PageSheet'
import SearchField from '../components/ios/SearchField'
import GoalRing from '../goals/GoalRing'
import { GOAL_KINDS, KIND_LABEL_KEYS, goalPercent, goalsQueryKey, isGoalComplete, setGoalParams } from '../goals/goals'

function GoalRow({ goal, onPin, onDelete, t, formatPrice }) {
  const progress = goal.progress || {}
  const complete = isGoalComplete(goal)
  return (
    <li className="flex items-center gap-1 border-t-[0.5px] border-border first:border-t-0" data-testid={`goal-row-${goal.id}`}>
      <Link to={`/goals/${goal.id}`} className="ios-press flex min-h-[64px] min-w-0 flex-1 items-center gap-3 px-4 py-2">
        <GoalRing percent={goalPercent(goal)} size={48} stroke={6} />
        <span className="min-w-0 flex-1">
          <span className="block break-words text-body text-text-primary">{goal.title}</span>
          <span className="block text-footnote tabular-nums text-text-secondary">
            {t('goals.ownedOfTotal').replace('{owned}', progress.owned ?? 0).replace('{total}', progress.total ?? 0)}
            {' · '}
            {complete ? t('goals.complete') : t('goals.toFinish').replace('{amount}', formatPrice(progress.cost_to_finish || 0))}
          </span>
        </span>
        <ChevronRight size={16} className="flex-shrink-0 text-text-tertiary" aria-hidden="true" />
      </Link>
      <button
        type="button"
        onClick={() => onPin(goal)}
        aria-pressed={Boolean(goal.pinned)}
        aria-label={goal.pinned ? t('goals.unpin') : t('goals.pin')}
        className="ios-press grid h-11 w-11 flex-shrink-0 place-items-center text-tint"
      >
        {goal.pinned ? <Pin size={18} aria-hidden="true" /> : <PinOff size={18} className="text-text-secondary" aria-hidden="true" />}
      </button>
      <button
        type="button"
        onClick={() => onDelete(goal)}
        aria-label={t('goals.delete')}
        className="ios-press mr-1 grid h-11 w-11 flex-shrink-0 place-items-center text-red"
      >
        <Trash2 size={18} aria-hidden="true" />
      </button>
    </li>
  )
}

function PickRow({ title, subtitle, onPick, testId, disabled }) {
  return <ListRow title={title} subtitle={subtitle} onClick={onPick} disabled={disabled} chevron testId={testId} />
}

function SetPicker({ kind, onCreate, t }) {
  const [query, setQuery] = useState('')
  const { data } = useQuery({ queryKey: ['sets', 'all'], queryFn: () => getSets({ lang: 'all' }).then(r => r.data) })
  const sets = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const list = Array.isArray(data) ? data : []
    return list.filter(set => !needle || String(set.name || '').toLowerCase().includes(needle)).slice(0, 60)
  }, [data, query])
  return (
    <div className="space-y-3">
      <SearchField value={query} onChange={setQuery} placeholder={t('goals.searchSets')} onCancel={() => setQuery('')} />
      <ListSection className="mx-0">
        {sets.map(set => (
          <PickRow
            key={set.id}
            testId={`pick-set-${set.id}`}
            title={set.name}
            subtitle={[set.lang?.toUpperCase(), set.total ? t('goals.cardsCount').replace('{count}', set.total) : null].filter(Boolean).join(' · ')}
            onPick={() => onCreate(kind, setGoalParams(set))}
          />
        ))}
      </ListSection>
    </div>
  )
}

function ListPicker({ items, render, onPick }) {
  return (
    <ListSection className="mx-0">
      {items.map(item => {
        const { key, title, subtitle } = render(item)
        return <PickRow key={key} testId={`pick-${key}`} title={title} subtitle={subtitle} onPick={() => onPick(item)} />
      })}
    </ListSection>
  )
}

function ArtistPicker({ onCreate, t }) {
  const [query, setQuery] = useState('')
  const term = query.trim()
  const { data } = useQuery({
    queryKey: ['goal-options', 'artist', term],
    queryFn: () => getGoalOptions({ artist: term }),
    enabled: term.length >= 2,
  })
  return (
    <div className="space-y-3">
      <SearchField value={query} onChange={setQuery} placeholder={t('goals.searchArtists')} onCancel={() => setQuery('')} />
      <ListPicker
        items={data?.artists || []}
        render={item => ({ key: `artist-${item.artist}`, title: item.artist, subtitle: t('goals.cardsCount').replace('{count}', item.cards) })}
        onPick={item => onCreate('artist', { artist: item.artist })}
      />
    </div>
  )
}

function CustomPicker({ onCreate, t }) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState({})
  const [name, setName] = useState('')
  const term = query.trim()
  const binders = useQuery({ queryKey: ['binders'], queryFn: () => getBinders().then(r => r.data) })
  const results = useQuery({
    queryKey: ['goal-card-search', term],
    queryFn: () => searchCards({ name: term, page: 1, page_size: 20 }).then(r => r.data?.data || []),
    enabled: term.length >= 2,
  })
  const planned = (Array.isArray(binders.data) ? binders.data : []).filter(binder => ['wishlist', 'deck'].includes(binder.binder_type))
  const pickedIds = Object.keys(picked)
  const fromBinder = async (binder) => {
    try {
      const data = await getBinderCards(binder.id).then(r => r.data)
      const ids = [...new Set((data?.cards || []).map(card => card.id).filter(Boolean))]
      if (!ids.length) {
        toast.error(t('goals.binderEmpty'))
        return
      }
      onCreate('custom', { card_ids: ids, name: binder.name })
    } catch {
      toast.error(t('goals.createFailed'))
    }
  }
  return (
    <div className="space-y-4">
      {planned.length > 0 && (
        <div className="space-y-1.5">
          <p className="px-1 text-footnote text-text-secondary">{t('goals.fromBinder')}</p>
          <ListPicker items={planned} render={binder => ({ key: `binder-${binder.id}`, title: binder.name })} onPick={fromBinder} />
        </div>
      )}
      <div className="space-y-2">
        <p className="px-1 text-footnote text-text-secondary">{t('goals.fromCards')}</p>
        <input
          value={name}
          onChange={event => setName(event.target.value)}
          maxLength={80}
          placeholder={t('goals.namePlaceholder')}
          aria-label={t('goals.namePlaceholder')}
          className="min-h-[44px] w-full rounded-xl bg-card px-4 text-body text-text-primary"
        />
        <SearchField value={query} onChange={setQuery} placeholder={t('goals.searchCards')} onCancel={() => setQuery('')} />
        <ListSection className="mx-0">
          {(results.data || []).map(card => (
            <ListRow
              key={card.id}
              title={card.name}
              subtitle={[card.set_ref?.name || card.set_id, card.number, card.lang?.toUpperCase()].filter(Boolean).join(' · ')}
              trailing={picked[card.id] ? <Check size={18} className="text-tint" aria-hidden="true" /> : null}
              onClick={() => setPicked(prev => {
                const next = { ...prev }
                if (next[card.id]) delete next[card.id]
                else next[card.id] = true
                return next
              })}
            />
          ))}
        </ListSection>
        <button
          type="button"
          disabled={!pickedIds.length}
          onClick={() => onCreate('custom', { card_ids: pickedIds, name: name.trim() || undefined })}
          className="btn-primary min-h-[44px] w-full disabled:opacity-40"
        >
          {t('goals.createFromPicked').replace('{count}', pickedIds.length)}
        </button>
      </div>
    </div>
  )
}

function NewGoalSheet({ isOpen, onClose, onCreate, t }) {
  const [kind, setKind] = useState(null)
  const options = useQuery({ queryKey: ['goal-options'], queryFn: () => getGoalOptions(), enabled: isOpen })
  const close = () => { setKind(null); onClose() }
  const create = (goalKind, params) => onCreate(goalKind, params, close)
  return (
    <PageSheet
      isOpen={isOpen}
      onClose={close}
      title={t('goals.newGoal')}
      leading={kind ? { label: t('common.back'), onPress: () => setKind(null) } : undefined}
    >
      <div className="space-y-3 px-4 pb-6" data-testid="goal-picker">
        {!kind && (
          <ListSection className="mx-0" header={t('goals.chooseKind')}>
            {GOAL_KINDS.map(option => (
              <ListRow
                key={option}
                testId={`kind-${option}`}
                title={t(KIND_LABEL_KEYS[option])}
                subtitle={t(`${KIND_LABEL_KEYS[option]}Desc`)}
                onClick={() => setKind(option)}
                chevron
              />
            ))}
          </ListSection>
        )}
        {(kind === 'set' || kind === 'set_master') && <SetPicker kind={kind} onCreate={create} t={t} />}
        {kind === 'generation' && (
          <ListPicker
            items={options.data?.generations || []}
            render={item => ({
              key: `generation-${item.generation}`,
              title: t('goals.generationN').replace('{n}', item.generation),
              subtitle: `${item.region} · ${t('goals.speciesCount').replace('{count}', item.species)}`,
            })}
            onPick={item => create('generation', { generation: item.generation })}
          />
        )}
        {kind === 'family' && (
          <ListPicker
            items={options.data?.families || []}
            render={item => ({ key: `family-${item.id}`, title: item.name, subtitle: t('goals.speciesCount').replace('{count}', item.dex_ids.length) })}
            onPick={item => create('family', { family: item.id })}
          />
        )}
        {kind === 'artist' && <ArtistPicker onCreate={create} t={t} />}
        {kind === 'custom' && <CustomPicker onCreate={create} t={t} />}
      </div>
    </PageSheet>
  )
}

export default function Goals() {
  const { user } = useAuth()
  const { t, formatPrice } = useSettings()
  const queryClient = useQueryClient()
  const confirm = useConfirmDialog()
  const [sheetOpen, setSheetOpen] = useState(false)

  const navBar = useMemo(() => ({
    title: t('goals.title'),
    trailing: (
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        aria-label={t('goals.newGoal')}
        className="ios-press grid h-11 w-11 place-items-center text-tint"
      >
        <Plus size={22} aria-hidden="true" />
      </button>
    ),
  }), [t])
  useNavBar(navBar)

  const queryKey = goalsQueryKey(user?.id)
  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: getGoals,
    enabled: Boolean(user?.id),
  })
  const goals = data?.goals || []
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['goals'] })

  const createMutation = useMutation({
    mutationFn: ({ kind, params }) => createGoal({ kind, params, pinned: true }),
    onSuccess: () => { toast.success(t('goals.created')); refresh() },
    onError: error => toast.error(error?.response?.status === 409 ? t('goals.duplicate') : t('goals.createFailed')),
  })
  const pinMutation = useMutation({
    mutationFn: goal => updateGoal(goal.id, { pinned: !goal.pinned }),
    onSuccess: refresh,
    onError: () => toast.error(t('goals.saveFailed')),
  })
  const deleteMutation = useMutation({
    mutationFn: goal => deleteGoal(goal.id),
    onSuccess: () => { toast.success(t('goals.deleted')); refresh() },
    onError: () => toast.error(t('goals.saveFailed')),
  })

  const onCreate = (kind, params, done) => createMutation.mutate({ kind, params }, { onSuccess: done })
  const onDelete = async goal => {
    const ok = await confirm({
      title: t('goals.deleteTitle'),
      message: t('goals.deleteMessage').replace('{name}', goal.title),
      confirmLabel: t('goals.delete'),
    })
    if (ok) deleteMutation.mutate(goal)
  }

  return (
    <div className="space-y-4 pb-4">
      <p className="px-1 text-subheadline text-text-secondary">{t('goals.intro')}</p>
      {isLoading ? (
        <div className="space-y-2">{[...Array(3)].map((_, i) => <div key={i} className="skeleton h-16 rounded-xl" />)}</div>
      ) : error && !data ? (
        <div className="card text-sm text-red" role="alert">{t('goals.loadFailed')}</div>
      ) : goals.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 py-10 text-center" data-testid="goals-empty">
          <Target size={32} className="text-tint" aria-hidden="true" />
          <p className="max-w-xs text-body text-text-secondary">{t('goals.empty')}</p>
          <button type="button" className="btn-primary min-h-[44px]" onClick={() => setSheetOpen(true)}>{t('goals.newGoal')}</button>
        </div>
      ) : (
        <ul className="overflow-hidden rounded-xl bg-card" aria-label={t('goals.title')}>
          {goals.map(goal => (
            <GoalRow
              key={goal.id}
              goal={goal}
              t={t}
              formatPrice={formatPrice}
              onPin={pinMutation.mutate}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
      <NewGoalSheet isOpen={sheetOpen} onClose={() => setSheetOpen(false)} onCreate={onCreate} t={t} />
    </div>
  )
}
