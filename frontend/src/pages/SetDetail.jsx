import { useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ownedFromQueryClient } from '../offline/carddb/owned.js'
import { PricesFromNote, useCatalogQuery } from '../offline/carddb/useCatalogQuery.jsx'
import { Plus, X, BookMarked, HelpCircle, ArrowUpDown, ListFilter, Layers } from 'lucide-react'
import { getSetChecklist, getBinders, addOwnedSetToBinder, addOwnedSetToAutoBinder } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'
import clsx from 'clsx'
import { resolveCardImageUrl, resolveSetImageUrl } from '../utils/imageUrl'
import { HOLO_FIELD_MAP } from '../utils/prices'
import { useDetailBackNavigation, useScrollToTopOnPush } from '../hooks/useListScrollRestoration'
import { useProgressiveCount } from '../hooks/useProgressiveCount'
import { CardDisplay, CardLegend } from '../components/card-system'
import { CardModal } from '../components/CardItem'
import HeaderBloom from '../components/ios/HeaderBloom'
import HpBar from '../components/ios/HpBar'
import Menu from '../components/ios/Menu'
import PokeBall from '../components/ios/PokeBall'
import SearchField from '../components/ios/SearchField'
import { colourFor } from '../components/ios/pokemon'
import { useNavBar } from '../navigation/useNavBar'
import BookView from '../components/book/BookView'
import BookViewSwitch from '../components/book/BookViewSwitch'
import { readViewPreference, setBookItems, writeViewPreference } from '../components/book/bookPages'
import { masterSetStats, splitVariantCards } from '../utils/setDetailStats'
import { tcgdexLanguageLabel } from '../utils/tcgdexLanguages'
import { setBackPath } from '../utils/setsLanguage'


const SET_SORT_OPTIONS = [
  'number',
  'price_desc',
  'price_asc',
  'name_asc',
  'name_desc',
]

function numberSortKey(value) {
  const text = value == null ? '' : String(value)
  const match = text.match(/^(\D*)(\d+)(.*)$/)
  if (!match) return [text.toLowerCase(), Number.MAX_SAFE_INTEGER, '']
  return [match[1].toLowerCase(), Number(match[2]), match[3].toLowerCase()]
}

function compareNumberLike(a, b) {
  const left = numberSortKey(a)
  const right = numberSortKey(b)
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' })
}

function positivePrice(value) {
  if (value == null) return null
  const price = Number(value)
  return Number.isFinite(price) && price > 0 ? price : null
}

function setSortPrice(card, pricePrimaryField) {
  const holoField = HOLO_FIELD_MAP[pricePrimaryField]
  const candidates = [
    card?.[pricePrimaryField],
    holoField ? card?.[holoField] : null,
    card?.price_market_holo,
    card?.price_market,
  ]
    .map(positivePrice)
    .filter(price => price != null)
  return candidates.length ? Math.max(...candidates) : 0
}

function sortSetCards(cards, sortBy, pricePrimaryField) {
  const sorted = [...cards]
  sorted.sort((a, b) => {
    if (sortBy === 'price_desc' || sortBy === 'price_asc') {
      const priceA = setSortPrice(a, pricePrimaryField)
      const priceB = setSortPrice(b, pricePrimaryField)
      const priceCompare = sortBy === 'price_desc' ? priceB - priceA : priceA - priceB
      if (priceCompare !== 0) return priceCompare
      return compareNumberLike(a.number, b.number)
    }
    if (sortBy === 'name_asc' || sortBy === 'name_desc') {
      const nameCompare = String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
      if (nameCompare !== 0) return sortBy === 'name_asc' ? nameCompare : -nameCompare
      return compareNumberLike(a.number, b.number)
    }
    return compareNumberLike(a.number, b.number)
  })
  return sorted
}

function ProgressRing({ fraction, size = 84 }) {
  const stroke = 7
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = Math.min(1, Math.max(0, fraction))
  return (
    <div className="relative grid flex-shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center"><PokeBall size={size * 0.4} gloss /></div>
    </div>
  )
}

export default function SetDetail() {
  const { setId } = useParams()
  const goBack = useDetailBackNavigation('sets', setBackPath(setId))
  useScrollToTopOnPush()
  const { t, pricePrimaryField, formatPrice } = useSettings()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('all')
  const [sortBy, setSortBy] = useState('number')
  const [rarityFilter, setRarityFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [splitVariants, setSplitVariants] = useState(false)
  const [selectedCard, setSelectedCard] = useState(null)
  const [selectedCardTab, setSelectedCardTab] = useState('add')
  const [binderPickerOpen, setBinderPickerOpen] = useState(false)
  const [badgeLegendOpen, setBadgeLegendOpen] = useState(false)
  const [viewMode, setViewMode] = useState(() => readViewPreference('set'))
  const changeViewMode = mode => {
    setViewMode(mode)
    writeViewPreference('set', mode)
  }

  const { data, isLoading, error, source: dataSource, pricesUpdatedAt } = useCatalogQuery({
    queryKey: ['set-checklist', setId],
    queryFn: () => getSetChecklist(setId).then(r => r.data),
    offlineFn: cardDb => cardDb.setChecklist(setId, ownedFromQueryClient(queryClient)),
  })

  const setLang = data?.set?.lang || 'en'

  const bindersQuery = useQuery({
    queryKey: ['binders'],
    queryFn: () => getBinders().then(r => r.data),
    enabled: binderPickerOpen,
  })

  // Synchronous re-entry lock. `disabled={isPending}` is async React state and
  // does not block a rapid second click before the re-render, which would create
  // a duplicate binder; this ref blocks it immediately.
  const addOwnedSubmittingRef = useRef(false)

  const addOwnedMutation = useMutation({
    mutationFn: async ({ binderId, setId }) => {
      if (!binderId) return addOwnedSetToAutoBinder(setId)
      return addOwnedSetToBinder(binderId, setId)
    },
    onSuccess: (result) => {
      const skipped = (result.skipped_present || 0) + (result.skipped_no_capacity || 0)
      toast.success(t('setDetail.addOwnedToBinderResult').replace('{added}', result.added).replace('{skipped}', skipped))
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      setBinderPickerOpen(false)
    },
    onError: () => toast.error(t('setDetail.addOwnedToBinderFailed')),
    onSettled: () => { addOwnedSubmittingRef.current = false },
  })

  const submitAddOwned = (args) => {
    if (addOwnedSubmittingRef.current) return
    addOwnedSubmittingRef.current = true
    addOwnedMutation.mutate(args)
  }

  const cards = useMemo(() => data?.cards ?? [], [data])
  const rarityOptions = useMemo(() => [...new Set(cards.map(card => card.rarity).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' })), [cards])

  // The release date comes from the cached sets list (the checklist payload has none).
  const releaseDate = useMemo(() => {
    for (const [, list] of queryClient.getQueriesData({ queryKey: ['sets'] })) {
      const found = Array.isArray(list) ? list.find(item => String(item.id) === String(setId)) : null
      if (found?.release_date) return found.release_date
    }
    return null
  }, [queryClient, setId, data])

  const navBar = useMemo(() => ({
    title: data?.set?.name ?? t('nav.sets'),
    trailing: (
      <Menu
        label={t('ios.more')}
        sections={[
          [
            { id: 'split', label: t('setDetail.splitVariants'), icon: Layers, checked: splitVariants, onSelect: () => setSplitVariants(value => !value) },
            { id: 'legend', label: t('setDetail.badgeLegend'), icon: HelpCircle, onSelect: () => setBadgeLegendOpen(open => !open) },
            { id: 'binder', label: t('setDetail.addOwnedToBinder'), icon: BookMarked, onSelect: () => setBinderPickerOpen(true) },
          ],
        ]}
      />
    ),
  }), [data?.set?.name, splitVariants, t])
  useNavBar(navBar)

  const setColour = colourFor(data?.set?.id ?? setId)

  const filteredCards = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matching = cards.filter(card => {
      if (!data?.owned_unknown && filter === 'owned' && !card.owned) return false
      if (!data?.owned_unknown && filter === 'missing' && card.owned) return false
      if (rarityFilter !== 'all' && card.rarity !== rarityFilter) return false
      if (needle && !(String(card.name || '').toLowerCase().includes(needle) || String(card.number || '').toLowerCase().includes(needle))) return false
      return true
    })
    return sortSetCards(matching, sortBy, pricePrimaryField)
  }, [cards, filter, pricePrimaryField, query, rarityFilter, sortBy])

  const tiles = useMemo(
    () => (splitVariants ? filteredCards.flatMap(card => splitVariantCards(card)) : filteredCards.map(card => ({ key: card.id, card, source: card }))),
    [filteredCards, splitVariants],
  )

  const bookItems = useMemo(() => (viewMode === 'book' ? setBookItems(tiles) : []), [tiles, viewMode])

  const shownTiles = useProgressiveCount(tiles.length, { resetKey: `${setId}|${filter}|${sortBy}|${rarityFilter}|${query}|${splitVariants}` })

  const openCard = source => {
    setSelectedCardTab('add')
    setSelectedCard(source)
  }

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-32 rounded-2xl" />
        <div className="skeleton h-24 rounded-2xl" />
        <div className="grid grid-cols-3 gap-2">
          {[...Array(12)].map((_, i) => <div key={i} className="skeleton aspect-[2.5/3.5] rounded-lg" />)}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="card text-center py-12">
        <p className="text-brand-red">{t('setDetail.loadFailed')} {error.message}</p>
        <button onClick={goBack} className="btn-ghost mt-4 mx-auto">
          {t('setDetail.goBack')}
        </button>
      </div>
    )
  }

  const { set, owned_count, total_count, progress, owned_unknown: ownedUnknown } = data || {}
  const numericProgress = Number(progress)
  const safeProgress = Number.isFinite(numericProgress)
    ? Math.min(100, Math.max(0, numericProgress))
    : 0
  // A set whose own-language cards are not available yet is filled with another language's cards
  // (the server's missing-language fallback); say so instead of passing them off as the set's own.
  const borrowed = cards.filter(card => card.data_source_lang && card.data_source_lang !== set?.lang)
  const borrowedFrom = borrowed.length * 2 >= cards.length && borrowed.length > 0 ? borrowed[0].data_source_lang : null
  const ownedValue = cards.reduce((sum, card) => (card.owned ? sum + setSortPrice(card, pricePrimaryField) : sum), 0)
  // The cheapest way to finish: the selected price of every card still missing (none when complete).
  const missingCards = cards.filter(card => !card.owned)
  const costToComplete = missingCards.length
    ? missingCards.reduce((sum, card) => sum + (positivePrice(card?.[pricePrimaryField]) ?? positivePrice(card?.price_market) ?? 0), 0)
    : null
  const master = masterSetStats(cards, card => setSortPrice(card, pricePrimaryField))
  const releaseLabel = releaseDate
    ? (() => {
      const d = new Date(releaseDate)
      return isNaN(d.getTime()) ? releaseDate : d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })
    })()
    : null

  const filterOptions = ownedUnknown ? [{ key: 'all', label: `${t('setDetail.all')} (${cards.length})` }] : [
    { key: 'all', label: `${t('setDetail.all')} (${cards.length})` },
    { key: 'owned', label: `${t('setDetail.owned')} (${owned_count})` },
    { key: 'missing', label: `${t('setDetail.missing')} (${total_count - owned_count})` },
  ]

  return (
    <div className="relative isolate space-y-4 pb-2">
      <HeaderBloom colour={setColour} />

      {/* Banner in the set's colour */}
      <div
        data-testid="set-banner"
        className="flex items-center gap-4 overflow-hidden rounded-[22px] p-4"
        style={{ background: `linear-gradient(150deg, var(--type-${setColour}-top), var(--type-${setColour}-bottom))`, boxShadow: `0 8px 24px color-mix(in srgb, var(--type-${setColour}) 40%, transparent)` }}
      >
        <div className="grid h-16 w-28 flex-shrink-0 place-items-center">
          {resolveSetImageUrl(set, 'logo')
            ? <img src={resolveSetImageUrl(set, 'logo')} alt={set.name} className="max-h-full max-w-full object-contain drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]" />
            : <span className="text-title-3 font-display text-center text-white">{set?.name}</span>}
        </div>
        <div className="min-w-0 flex-1 text-white">
          <h1 className="truncate text-title-2 font-display">{set?.name}</h1>
          <p className="truncate text-footnote opacity-90">{[set?.series, set?.lang ? tcgdexLanguageLabel(set.lang) : null].filter(Boolean).join(' · ')}</p>
          <p className="text-footnote opacity-90">
            {[releaseLabel, `${total_count} ${t('setDetail.cards')}`].filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>

      <PricesFromNote source={dataSource} pricesUpdatedAt={pricesUpdatedAt} className="px-1" />

      {borrowedFrom && (
        <p data-testid="fallback-language-note" className="px-1 text-footnote text-text-secondary">
          {t('setDetail.borrowedCards').replace('{lang}', tcgdexLanguageLabel(set?.lang)).replace('{source}', tcgdexLanguageLabel(borrowedFrom))}
        </p>
      )}

      {ownedUnknown && (
        <p data-testid="owned-unavailable" className="px-1 text-footnote text-text-secondary">{t('offlineDb.ownedUnavailable')}</p>
      )}

      {/* Swipeable stat cards */}
      {!ownedUnknown && <div
        data-testid="set-stat-cards"
        className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <section aria-label={t('setDetail.completeSet')} className="w-[88%] flex-shrink-0 snap-center rounded-[22px] bg-card p-4">
          <div className="flex items-center gap-4">
            <ProgressRing fraction={safeProgress / 100} />
            <div className="min-w-0 flex-1 space-y-1.5">
              <p className="text-footnote text-text-secondary">{t('setDetail.completeSet')}</p>
              <p className="text-title-2 font-display tabular-nums">{t('setDetail.xOfY').replace('{owned}', owned_count).replace('{total}', total_count)}</p>
              <HpBar value={owned_count} max={total_count} label={t('setDetail.completeSet')} />
              <p className="text-footnote tabular-nums text-text-secondary">{safeProgress}% · {formatPrice(ownedValue)}</p>
              {costToComplete != null && (
                <p data-testid="set-cost-to-complete" className="text-footnote tabular-nums text-text-secondary">
                  {t('setDetail.costToComplete')}: {formatPrice(costToComplete)}
                </p>
              )}
            </div>
          </div>
        </section>
        <section aria-label={t('setDetail.masterSet')} className="w-[88%] flex-shrink-0 snap-center rounded-[22px] bg-card p-4">
          <div className="space-y-1.5">
            <p className="text-footnote text-text-secondary">{t('setDetail.masterSet')}</p>
            <p className="text-title-2 font-display tabular-nums">{t('setDetail.printingsOf').replace('{owned}', master.owned).replace('{total}', master.total)}</p>
            <HpBar value={master.owned} max={master.total} label={t('setDetail.masterSet')} />
            <p className="text-footnote tabular-nums text-text-secondary">{t('setDetail.ownedValue')} {formatPrice(master.value)}</p>
          </div>
        </section>
      </div>}

      {/* Search, sort and filter */}
      <div className="flex items-center gap-2">
        <SearchField
          className="min-w-0 flex-1"
          value={query}
          onChange={setQuery}
          placeholder={t('setDetail.searchInSet')}
          onCancel={() => setQuery('')}
        />
        <Menu
          label={t('setDetail.sortBy')}
          trigger={(
            <button type="button" aria-label={t('setDetail.sortBy')} className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-full bg-fill-tertiary ios-press">
              <ArrowUpDown size={16} aria-hidden="true" />
            </button>
          )}
          sections={[SET_SORT_OPTIONS.map(option => ({
            id: option,
            label: t(`setDetail.sort.${option}`),
            checked: sortBy === option,
            onSelect: () => setSortBy(option),
          }))]}
        />
        <Menu
          label={t('setDetail.filterMenu')}
          trigger={(
            <button type="button" aria-label={t('setDetail.filterMenu')} className={clsx('grid h-9 w-9 flex-shrink-0 place-items-center rounded-full bg-fill-tertiary ios-press', (filter !== 'all' || rarityFilter !== 'all') && 'text-tint')}>
              <ListFilter size={16} aria-hidden="true" />
            </button>
          )}
          sections={[
            filterOptions.map(({ key, label }) => ({ id: `f-${key}`, label, checked: filter === key, onSelect: () => setFilter(key) })),
            [{ id: 'r-all', label: t('setDetail.allRarities'), checked: rarityFilter === 'all', onSelect: () => setRarityFilter('all') },
              ...rarityOptions.map(rarity => ({ id: `r-${rarity}`, label: rarity, checked: rarityFilter === rarity, onSelect: () => setRarityFilter(rarity) }))],
          ]}
        />
      </div>

      <div className="flex items-center justify-between gap-2 text-footnote text-text-secondary">
        <span className="min-w-0 flex-1 truncate">{t('setDetail.showingCards').replace('{count}', tiles.length).replace('{total}', cards.length)}</span>
        <BookViewSwitch value={viewMode} onChange={changeViewMode} />
        <button
          type="button"
          role="switch"
          aria-checked={splitVariants}
          onClick={() => setSplitVariants(value => !value)}
          className={clsx('flex h-8 items-center gap-1.5 rounded-full px-3 font-semibold ios-press', splitVariants ? 'bg-tint text-on-accent' : 'bg-fill-tertiary')}
        >
          <Layers size={14} aria-hidden="true" /> {t('setDetail.splitVariants')}
        </button>
      </div>

      {badgeLegendOpen && (
        <div id="card-badge-legend" className="rounded-2xl bg-card p-3">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t('setDetail.badgeLegend')}
          </p>
          <CardLegend collapsible={false} />
        </div>
      )}

      {viewMode === 'book' && (
        <BookView
          items={bookItems}
          resetKey={`${setId}|${filter}|${rarityFilter}|${query}|${splitVariants}`}
          renderPocket={item => (
            <CardDisplay
              variant="artwork"
              card={item.card}
              image={resolveCardImageUrl(item.source)}
              alt={item.name}
              interactive
              dimmed={item.ghost}
              onClick={() => openCard(item.source)}
            />
          )}
        />
      )}

      {/* Card Grid */}
      <div className={clsx('grid grid-cols-3 gap-2', viewMode === 'book' && 'hidden')}>
        {viewMode !== 'book' && tiles.slice(0, shownTiles).map(({ key, card, source }) => (
          <CardDisplay
            key={key}
            card={card}
            image={resolveCardImageUrl(source)}
            price={setSortPrice(source, pricePrimaryField) > 0 ? formatPrice(setSortPrice(source, pricePrimaryField)) : null}
            dimWhenUnowned
            onClick={() => {
              setSelectedCardTab('add')
              setSelectedCard(source)
            }}
            onAdd={() => {
              setSelectedCardTab('add')
              setSelectedCard(source)
            }}
          />
        ))}
      </div>

      {selectedCard && <CardModal
        key={selectedCard.id}
        card={selectedCard}
        defaultLang={setLang}
        initialTab={selectedCardTab}
        onClose={() => setSelectedCard(null)}
      />}

      {binderPickerOpen && createPortal(
        <div
          className="fixed inset-0 z-50 bg-black/75 md:flex md:items-center md:justify-center md:bg-black/80"
          onClick={() => setBinderPickerOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-owned-to-binder-title"
            className={[
              'fixed bottom-0 left-0 right-0 rounded-t-2xl max-h-[90dvh] overflow-y-auto',
              'bg-bg-surface border-t border-border more-sheet-enter',
              'md:static md:w-full md:max-w-md md:rounded-2xl md:border md:max-h-[85vh] md:animate-none',
            ].join(' ')}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-center pt-3 pb-1 md:hidden">
              <div className="w-10 h-1 bg-border rounded-full" />
            </div>

            <div className="p-5">
              <div className="flex items-start justify-between gap-3 mb-4">
                <h2 id="add-owned-to-binder-title" className="text-lg font-bold text-text-primary">
                  {t('setDetail.addOwnedToBinderTitle')}
                </h2>
                <button
                  onClick={() => setBinderPickerOpen(false)}
                  className="text-text-muted hover:text-text-primary flex-shrink-0 p-1"
                  aria-label={t('common.close')}
                >
                  <X size={18} />
                </button>
              </div>

              {!owned_count ? (
                <p className="text-sm text-text-secondary">{t('setDetail.addOwnedToBinderEmpty')}</p>
              ) : (
                <>
                  <p className="text-xs font-semibold text-text-muted mb-2 uppercase tracking-wide">
                    {t('setDetail.addOwnedToBinderPick')}
                  </p>
                  <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
                    {bindersQuery.isLoading && (
                      <p className="text-sm text-text-secondary">{t('common.loading')}</p>
                    )}
                    {bindersQuery.isError && (
                      <p className="text-sm text-brand-red">{t('setDetail.addOwnedToBinderLoadFailed')}</p>
                    )}
                    {!bindersQuery.isLoading && !bindersQuery.isError && (bindersQuery.data || []).filter(b => (b.binder_type || 'collection') === 'collection').length === 0 && (
                      <p className="text-sm text-text-secondary">{t('setDetail.addOwnedToBinderNoBinders')}</p>
                    )}
                    {(bindersQuery.data || []).filter(b => (b.binder_type || 'collection') === 'collection').map(b => (
                      <button
                        key={b.id}
                        disabled={addOwnedMutation.isPending}
                        onClick={() => submitAddOwned({ binderId: b.id, setId: set.id })}
                        className="text-left px-3 py-2.5 rounded-xl border border-border bg-bg-card hover:border-brand-red/40 hover:bg-brand-red/10 text-sm text-text-primary transition-colors disabled:opacity-50"
                      >
                        {b.name}
                      </button>
                    ))}
                  </div>
                  <button
                    disabled={addOwnedMutation.isPending}
                    onClick={() => submitAddOwned({ binderId: null, setId: set.id })}
                    className="btn-primary w-full mt-3 flex items-center justify-center gap-1.5 text-sm disabled:opacity-50"
                  >
                    <Plus size={14} /> {t('setDetail.addOwnedToBinderNew')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
