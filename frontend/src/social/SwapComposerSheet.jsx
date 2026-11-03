import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Check, ChevronLeft, Plus, Wallet, X } from 'lucide-react'
import PageSheet from '../components/ios/PageSheet'
import ListRow from '../components/ios/ListRow'
import Button from '../components/ios/Button'
import IconButton from '../components/ios/IconButton'
import SearchField from '../components/ios/SearchField'
import SegmentedControl from '../components/ios/SegmentedControl'
import MoneyInput from '../components/MoneyInput'
import { useSettings } from '../contexts/SettingsContext'
import { useAuth } from '../contexts/AuthContext'
import { useOffline } from '../offline/useOffline'
import { counterSwap, createSwap, getApiErrorMessage, getSwapCandidates } from '../api/client'
import { parseMoneyInputValue } from '../utils/moneyInput'
import { SWAPS_QUERY_KEY, SWAPS_WAITING_QUERY_KEY } from './social'
import { CardArt, FairTradeMeter, WishlistHeart } from './SwapParts'
import { pickedToBody } from './swapHelpers'
import CardFilterSheet, { CardFilterButton, useCardFilterSheet } from '../components/CardFilterPanel'
import { CARD_FILTER_DEFAULTS, countActiveCardFilters, hasAdvancedCardFilters } from '../utils/cardFilters'
import { candidateFacets, defaultQuickChoice, filterCandidates, prepareCandidates } from './swapPicker'

const fill = (text, values) => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, value), text)

const cardCode = item => [item.set_code || item.set_id?.toUpperCase(), item.card_number].filter(Boolean).join(' ')
const cardDetail = item => [cardCode(item), item.variant].filter(Boolean).join(' · ')

/** An offer's item in the picker's candidate shape (for counters and "send again"). */
function itemToCandidate(item) {
  return {
    collection_item_id: item.collection_item_id,
    card_id: item.card_id,
    card_name: item.card_name,
    set_id: item.set_id,
    set_code: item.set_code,
    card_number: item.card_number,
    variant: item.variant,
    types: item.types,
    value: Number(item.value_per_card) || 0,
    offerable: 99,
    on_wishlist: false,
  }
}

function SwapCardRow({ item, quantity, wishlistLabel, valueText, removeLabel, onRemove, last }) {
  return (
    <div className="relative flex items-center gap-3 py-2.5 pl-4 pr-1.5">
      <CardArt item={item} />
      <span className="min-w-0 flex-1">
        <span className="block text-body">{quantity > 1 ? `×${quantity} ` : ''}{item.card_name}</span>
        <span className="block text-footnote text-text-secondary">{cardDetail(item)}</span>
        {wishlistLabel && (
          <span className="flex items-center gap-1 text-caption-1 font-semibold" style={{ color: '#EF6FAE' }}>
            <WishlistHeart />
            {wishlistLabel}
          </span>
        )}
      </span>
      <span className="flex-shrink-0 text-body tabular-nums text-text-secondary">{valueText}</span>
      <IconButton icon={X} label={removeLabel} variant="gray" size="sm" className="!h-8 !w-8" onClick={onRemove} />
      {!last && <span aria-hidden="true" className="absolute bottom-0 left-[68px] right-0 h-[0.5px] bg-border" />}
    </div>
  )
}

function SwapSide({ title, entries, addLabel, onAdd, onRemove, wishlistLabel, formatPrice, removeLabel }) {
  return (
    <section className="mx-4">
      <h3 className="px-4 pb-1.5 text-footnote text-text-secondary">{title}</h3>
      <div className="overflow-hidden rounded-xl bg-card">
        {entries.map(([id, entry]) => (
          <SwapCardRow
            key={id}
            item={entry.item}
            quantity={entry.quantity}
            wishlistLabel={entry.item.on_wishlist ? wishlistLabel : null}
            valueText={formatPrice((Number(entry.item.value) || 0) * entry.quantity)}
            removeLabel={fill(removeLabel, { name: entry.item.card_name })}
            onRemove={() => onRemove(id)}
          />
        ))}
        <ListRow icon={Plus} iconColor="var(--color-green)" title={addLabel} onClick={onAdd} chevron />
      </div>
    </section>
  )
}

function PickerTile({ item, quantity, formatPrice, t }) {
  const selected = quantity > 0
  const spare = Number(item.spare) > 0 ? fill(t('swaps.spareCount'), { count: item.spare }) : null
  const label = [
    item.card_name,
    cardCode(item),
    formatPrice(item.value),
    item.on_wishlist ? t('swaps.onWishlistShort') : null,
    spare,
    selected ? t('swaps.selected') : null,
  ].filter(Boolean).join(', ')
  return (
    <span className="flex min-w-0 flex-col gap-1 text-left" aria-hidden="false">
      <span
        className="relative block w-full"
        style={{ aspectRatio: '5 / 7' }}
      >
        <CardArt
          item={item}
          width="100%"
          height="100%"
          radius={8}
          glow={false}
          style={selected ? { boxShadow: '0 0 0 3px var(--color-tint)' } : undefined}
        />
        {item.on_wishlist && (
          <span aria-hidden="true" className="absolute bottom-1.5 left-1.5 grid h-[22px] w-[22px] place-items-center rounded-full bg-black/60">
            <WishlistHeart />
          </span>
        )}
        {Number(item.offerable) > 1 && !selected && (
          <span aria-hidden="true" className="absolute bottom-1.5 right-1.5 rounded-full bg-black/70 px-1.5 py-0.5 text-caption-1 font-semibold leading-4">×{item.offerable}</span>
        )}
        {selected && (
          <span aria-hidden="true" className="absolute -right-[7px] -top-[7px] grid h-6 w-6 place-items-center rounded-full bg-accent text-white shadow-[0_0_0_2px_var(--color-card)]">
            {quantity > 1 ? <span className="text-caption-1 font-semibold leading-none">{quantity}</span> : <Check size={14} strokeWidth={3} />}
          </span>
        )}
        <span className="sr-only">{label}</span>
      </span>
      <span className="truncate text-caption-1 font-semibold">{item.card_name}</span>
      <span className="flex justify-between gap-1 text-text-secondary">
        <span className="text-caption-2">{cardCode(item)}</span>
        <span className="text-caption-1 tabular-nums">{formatPrice(item.value)}</span>
      </span>
    </span>
  )
}

const PAGE_SIZE = 60

/** Renders `items` a page at a time: the next page loads when the end of the grid scrolls into view. */
function usePagedItems(items, resetKey) {
  const [count, setCount] = useState(PAGE_SIZE)
  const sentinel = useRef(null)
  useEffect(() => { setCount(PAGE_SIZE) }, [resetKey])
  const more = count < items.length
  useEffect(() => {
    const node = sentinel.current
    if (!more || !node) return undefined
    if (typeof IntersectionObserver === 'undefined') { setCount(items.length); return undefined }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) setCount(current => current + PAGE_SIZE)
    }, { rootMargin: '600px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [more, count, items.length])
  return { visible: items.slice(0, count), more, sentinel }
}

function Picker({ owner, partnerName, picked, onToggle, candidatesFor, t, formatPrice }) {
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState(CARD_FILTER_DEFAULTS)
  const mine = owner === 'me'
  const base = useQuery({
    queryKey: ['swap-candidates', candidatesFor.partnerId, mine ? 'give' : 'get', 'all', ''],
    queryFn: () => getSwapCandidates({ partner_id: candidatesFor.partnerId, side: mine ? 'give' : 'get', filter: 'all' }),
    staleTime: 15000,
  })
  const counts = base.data?.counts ?? { all: 0, spares: 0, wishlist: 0 }
  const options = [
    {
      value: 'wishlist',
      label: fill(t('swaps.pickerWishlist'), { count: counts.wishlist }),
      ariaLabel: fill(t(mine ? 'swaps.pickerTheirWishlist' : 'swaps.pickerYourWishlist'), { name: partnerName, count: counts.wishlist }),
    },
    { value: 'spares', label: fill(t('swaps.pickerSpares'), { count: counts.spares }) },
    { value: 'all', label: fill(t('swaps.pickerAll'), { count: counts.all }) },
  ]
  const [quick, setQuick] = useState(null)
  const effective = quick ?? defaultQuickChoice({ counts, wishlistVisible: base.data?.wishlist_visible })

  const prepared = useMemo(() => prepareCandidates(base.data?.items), [base.data])
  const facets = useMemo(() => candidateFacets(prepared), [prepared])
  const items = useMemo(
    () => filterCandidates(prepared, { quick: effective, term: search, filters }),
    [prepared, effective, search, filters],
  )

  const activeFilterCount = countActiveCardFilters(filters)
  const hasAdvanced = hasAdvancedCardFilters(filters)
  const sheet = useCardFilterSheet(hasAdvanced)
  const setFilter = (key, value) => setFilters(current => ({ ...current, [key]: value }))
  const clearFilters = () => { setFilters(CARD_FILTER_DEFAULTS); sheet.setAdvancedOpen(false) }
  const clearAll = () => { clearFilters(); setSearch(''); setQuick(null) }
  const narrowed = activeFilterCount > 0 || search.trim() !== '' || (quick !== null && quick !== 'all')
  const paged = usePagedItems(items, `${effective}|${search}|${JSON.stringify(filters)}`)

  const placeholder = fill(t(mine ? 'swaps.searchYours' : 'swaps.searchTheirs'), { name: partnerName })
  const total = base.data?.items?.length ?? 0
  return (
    <div className="flex flex-col gap-3 p-4">
      <SearchField value={search} onChange={setSearch} placeholder={placeholder} ariaLabel={placeholder} />
      <SegmentedControl options={options} value={effective} onChange={setQuick} ariaLabel={t('swaps.show')} />
      <div className="flex items-center gap-2">
        <CardFilterButton count={activeFilterCount} onPress={sheet.open} />
        {narrowed && (
          <button type="button" onClick={clearAll} className="ios-press inline-flex min-h-[44px] items-center px-1 text-footnote font-semibold text-tint">
            {t('swaps.clearAll')}
          </button>
        )}
        {!base.isLoading && total > 0 && (
          <span role="status" className="ml-auto text-footnote tabular-nums text-text-secondary">
            {fill(t('swaps.pickerShowing'), { shown: items.length, total })}
          </span>
        )}
      </div>
      <CardFilterSheet
        sheet={sheet}
        filters={filters}
        onChange={setFilter}
        onClear={clearFilters}
        hasActive={activeFilterCount > 0}
        facets={facets}
        idPrefix="swap-picker"
      />
      {base.isLoading ? (
        <ul className="mt-1 grid grid-cols-3 gap-2.5">{[...Array(6)].map((_, index) => <li key={index} className="skeleton rounded-lg" style={{ aspectRatio: '5 / 7' }} />)}</ul>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-footnote text-text-secondary">
          {total > 0 ? t('swaps.pickerNoMatch') : t(mine ? 'swaps.pickerEmptyYours' : 'swaps.pickerEmptyTheirs').replace('{name}', partnerName)}
        </p>
      ) : (
        <>
          <ul className="mt-1 grid grid-cols-3 gap-2.5">
            {paged.visible.map(item => {
              const quantity = picked[item.collection_item_id]?.quantity ?? 0
              const detail = `${item.card_name}, ${cardCode(item)}, ${formatPrice(item.value)}${item.on_wishlist ? `, ${t('swaps.onWishlistShort')}` : ''}${quantity ? `, ${t('swaps.selected')}` : ''}`
              return (
                <li key={item.collection_item_id}>
                  <button
                    type="button"
                    aria-pressed={quantity > 0}
                    aria-label={detail}
                    onClick={() => onToggle(item)}
                    className="ios-press w-full min-w-0"
                  >
                    <PickerTile item={item} quantity={quantity} formatPrice={formatPrice} t={t} />
                  </button>
                </li>
              )
            })}
          </ul>
          {paged.more && <div ref={paged.sentinel} aria-hidden="true" className="h-10" />}
        </>
      )}
    </div>
  )
}

/**
 * The swap composer (docs/SOCIAL_DESIGN.md §5.4): a page sheet over Compare, the Offers segment or an
 * offer. `mode`: 'new', 'counter' (prefilled from `offer`) or 'again' (the same cards, sent as a new offer).
 * `initial`: { side: 'give' | 'get', cardId } puts that card on the table (Compare's "Offer a swap").
 */
export default function SwapComposerSheet({ isOpen, onClose, partner, mode = 'new', offer = null, initial = null }) {
  const { t, formatPrice, exchangeRate } = useSettings()
  const { user } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const offline = useOffline()
  const partnerId = partner?.id
  const partnerName = partner?.username ?? ''
  const [step, setStep] = useState(null) // null | 'me' | 'partner'
  const [give, setGive] = useState({})
  const [get, setGet] = useState({})
  const [cash, setCash] = useState('')
  const [payer, setPayer] = useState('me')
  const [cashOpen, setCashOpen] = useState(false)
  const [note, setNote] = useState('')
  const seeded = useRef(false)

  const giveQuery = useQuery({
    queryKey: ['swap-candidates', partnerId, 'give', 'all', ''],
    queryFn: () => getSwapCandidates({ partner_id: partnerId, side: 'give', filter: 'all' }),
    enabled: isOpen && Boolean(partnerId),
    staleTime: 15000,
  })
  const getQuery = useQuery({
    queryKey: ['swap-candidates', partnerId, 'get', 'all', ''],
    queryFn: () => getSwapCandidates({ partner_id: partnerId, side: 'get', filter: 'all' }),
    enabled: isOpen && Boolean(partnerId),
    staleTime: 15000,
  })

  // Seed the table once: a counter or "again" from the offer, "Offer a swap" from a suggestion.
  useEffect(() => {
    if (!isOpen) { seeded.current = false; return }
    if (seeded.current || !giveQuery.data || !getQuery.data) return
    seeded.current = true
    if (offer && (mode === 'counter' || mode === 'again')) {
      const nextGive = {}
      const nextGet = {}
      const mineAvailable = new Map(giveQuery.data.items.map(item => [item.collection_item_id, item]))
      const theirAvailable = new Map(getQuery.data.items.map(item => [item.collection_item_id, item]))
      offer.items.forEach(item => {
        const available = (item.gives ? mineAvailable : theirAvailable).get(item.collection_item_id)
        if (mode === 'again' && !available) return
        const candidate = available ?? itemToCandidate(item)
        const quantity = Math.min(item.quantity, Number(candidate.offerable) || item.quantity)
        if (quantity < 1) return
        ;(item.gives ? nextGive : nextGet)[item.collection_item_id] = { quantity, item: candidate }
      })
      setGive(nextGive)
      setGet(nextGet)
      if (Number(offer.cash?.amount) > 0) {
        setCash(String(Math.round(Number(offer.cash.amount) * Number(exchangeRate || 1) * 100) / 100))
        setPayer(offer.cash.payer_user_id === partnerId ? 'them' : 'me')
      }
    } else if (initial?.cardId) {
      const pool = initial.side === 'give' ? giveQuery.data.items : getQuery.data.items
      const match = pool.find(item => item.card_id === initial.cardId)
      if (match) (initial.side === 'give' ? setGive : setGet)({ [match.collection_item_id]: { quantity: 1, item: match } })
    }
  }, [isOpen, giveQuery.data, getQuery.data, offer, mode, initial, partnerId, exchangeRate])

  useEffect(() => {
    if (isOpen) return
    setStep(null); setGive({}); setGet({}); setCash(''); setPayer('me'); setCashOpen(false); setNote('')
  }, [isOpen])

  const cashEur = parseMoneyInputValue(cash, exchangeRate, 0) || 0
  const sum = map => Object.values(map).reduce((total, entry) => total + (Number(entry.item.value) || 0) * entry.quantity, 0)
  const gives = sum(give) + (payer === 'me' ? cashEur : 0)
  const gets = sum(get) + (payer === 'them' ? cashEur : 0)
  const missingPrices = [...Object.values(give), ...Object.values(get)].filter(entry => !(Number(entry.item.value) > 0)).length
  const count = Object.keys(give).length + Object.keys(get).length

  const send = useMutation({
    mutationFn: () => {
      const body = {
        items: [...pickedToBody(give), ...pickedToBody(get)],
        cash_amount: cashEur,
        cash_payer_user_id: cashEur > 0 ? (payer === 'me' ? user?.id : partnerId) : null,
        note: note.trim() || null,
      }
      return mode === 'counter'
        ? counterSwap(offer.id, { ...body, revision: offer.revision })
        : createSwap({ ...body, to_user_id: partnerId })
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: SWAPS_QUERY_KEY })
      queryClient.invalidateQueries({ queryKey: SWAPS_WAITING_QUERY_KEY })
      toast.success(fill(t(mode === 'counter' ? 'swaps.counterSent' : 'swaps.offerSent'), { name: partnerName }))
      onClose?.()
      navigate(`/trades/offers/${result.id}`)
    },
    onError: (error) => {
      toast.error(getApiErrorMessage(error, t('common.error')))
      queryClient.invalidateQueries({ queryKey: ['swap-candidates'] })
      if (offer) queryClient.invalidateQueries({ queryKey: [...SWAPS_QUERY_KEY, offer.id] })
    },
  })

  const toggle = (side) => (item) => {
    const setter = side === 'me' ? setGive : setGet
    setter(current => {
      const id = item.collection_item_id
      const existing = current[id]?.quantity ?? 0
      const max = Number(item.offerable) || 1
      const next = { ...current }
      if (existing >= max) delete next[id]
      else next[id] = { quantity: existing + 1, item }
      return next
    })
  }
  const removeFrom = setter => id => setter(current => { const next = { ...current }; delete next[id]; return next })
  const addChip = (item) => setGive(current => ({ ...current, [item.collection_item_id]: { quantity: 1, item } }))

  const matches = useMemo(() => {
    if (!giveQuery.data?.wishlist_visible) return []
    return giveQuery.data.items.filter(item => item.on_wishlist && item.spare && !give[item.collection_item_id])
  }, [giveQuery.data, give])

  const dirty = count > 0 || cashEur > 0 || note.trim().length > 0
  const title = step === 'me' ? t('swaps.yourCards') : step === 'partner' ? fill(t('swaps.theirSpares'), { name: partnerName }) : fill(t(mode === 'counter' ? 'swaps.counterTitle' : 'swaps.composerTitle'), { name: partnerName })
  const cashValue = cashEur > 0 ? fill(t(payer === 'me' ? 'swaps.cashYouPayValue' : 'swaps.cashTheyPayValue'), { name: partnerName, amount: formatPrice(cashEur) }) : t('swaps.none')

  const picker = step ? (
    <Picker
      owner={step}
      partnerName={partnerName}
      picked={step === 'me' ? give : get}
      onToggle={toggle(step)}
      candidatesFor={{ partnerId }}
      t={t}
      formatPrice={formatPrice}
    />
  ) : null

  return (
    <PageSheet
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      isDirty={dirty && !send.isPending}
      className="!h-[92dvh]"
      leading={step ? (
        <button type="button" aria-label={t('swaps.backToOffer')} onClick={() => setStep(null)} className="ios-press inline-flex min-h-[44px] items-center gap-0.5 pr-1 text-body text-tint">
          <ChevronLeft size={22} strokeWidth={2.25} aria-hidden="true" />{t('common.back')}
        </button>
      ) : undefined}
      trailing={step ? { label: t('ios.done'), onPress: () => setStep(null) } : undefined}
      footer={step ? undefined : (
        <div className="flex flex-col gap-3">
          <FairTradeMeter gives={gives} gets={gets} missingPrices={missingPrices} variant="compact" />
          <Button size="lg" full disabled={count === 0 || offline} loading={send.isPending} onClick={() => send.mutate()}>
            {t(mode === 'counter' ? 'swaps.sendCounter' : 'swaps.sendOffer')}
          </Button>
          {offline && <p className="-mt-1.5 text-center text-footnote text-text-secondary">{t('swaps.needsConnection')}</p>}
        </div>
      )}
    >
      {picker ?? (
        <div className="flex flex-col gap-4 py-4">
          <SwapSide
            title={t('swaps.youGive')}
            entries={Object.entries(give)}
            addLabel={t('swaps.addFromYours')}
            onAdd={() => setStep('me')}
            onRemove={removeFrom(setGive)}
            formatPrice={formatPrice}
            removeLabel={t('swaps.removeCard')}
          />
          <SwapSide
            title={fill(t('swaps.youGetFrom'), { name: partnerName })}
            entries={Object.entries(get)}
            addLabel={fill(t('swaps.addFromTheirs'), { name: partnerName })}
            onAdd={() => setStep('partner')}
            onRemove={removeFrom(setGet)}
            wishlistLabel={t('swaps.onYourWishlist')}
            formatPrice={formatPrice}
            removeLabel={t('swaps.removeCard')}
          />
          {matches.length > 0 && (
            <section>
              <h3 className="px-8 pb-1.5 text-footnote text-text-secondary">{fill(t('swaps.matchesHeader'), { name: partnerName })}</h3>
              <div className="flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {matches.map(item => (
                  <button
                    key={item.collection_item_id}
                    type="button"
                    aria-label={fill(t('swaps.addMatch'), { name: item.card_name, code: cardCode(item) })}
                    onClick={() => addChip(item)}
                    className="ios-press inline-flex min-h-[44px] flex-shrink-0 items-center gap-1.5 rounded-full bg-card pl-3 pr-4 text-subheadline font-semibold text-text-primary"
                  >
                    <Plus size={18} strokeWidth={2.25} className="text-tint" aria-hidden="true" />
                    {item.card_name} · {cardCode(item)}
                  </button>
                ))}
              </div>
            </section>
          )}
          <section className="mx-4">
            <h3 className="px-4 pb-1.5 text-footnote text-text-secondary">{t('swaps.cashAndNote')}</h3>
            <div className="overflow-hidden rounded-xl bg-card">
              <ListRow icon={Wallet} iconColor="var(--color-orange)" title={t('swaps.cash')} value={cashValue} onClick={() => setCashOpen(open => !open)} chevron className={cashOpen ? 'after:hidden' : ''} />
              {cashOpen && (
                <div className="flex flex-col gap-3 border-t-[0.5px] border-border px-4 py-3">
                  <MoneyInput
                    value={cash}
                    onChange={event => setCash(event.target.value)}
                    aria-label={t('swaps.cashAmount')}
                    className="input"
                  />
                  <SegmentedControl
                    options={[
                      { value: 'me', label: t('swaps.youPay') },
                      { value: 'them', label: fill(t('swaps.theyPay'), { name: partnerName }) },
                    ]}
                    value={payer}
                    onChange={setPayer}
                    ariaLabel={t('swaps.whoPays')}
                  />
                </div>
              )}
              <label className={`flex min-h-[44px] items-center px-4 py-[11px] ${cashOpen ? 'border-t-[0.5px] border-border' : ''}`}>
                <input
                  type="text"
                  maxLength={140}
                  value={note}
                  onChange={event => setNote(event.target.value)}
                  aria-label={t('swaps.noteLabel')}
                  placeholder={t('swaps.notePlaceholder')}
                  className="w-full bg-transparent text-body text-text-primary outline-none"
                />
              </label>
            </div>
            <p className="px-4 pt-1.5 text-footnote text-text-secondary">{t('swaps.cashFooter')}</p>
          </section>
        </div>
      )}
    </PageSheet>
  )
}
