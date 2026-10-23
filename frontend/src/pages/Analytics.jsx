import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  AreaChart, Area
} from 'recharts'
import { TrendingUp, TrendingDown, Plus, X, ShoppingCart, Info } from 'lucide-react'
import {
  getDuplicates, getTopMovers, getRarityStats,
  getInvestmentTracker, getDashboard, getTradeStats, getAnalyticsNewSets, getProducts, createProduct
} from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { CollectionCardIdentity, CollectionCardRow, OwnPhotoOverlayBadge, showsOwnPhoto, useCollectionPhotoUrl } from '../components/CollectionCardImage'
import { CardModal } from '../components/CardItem'
import { format, parseISO } from 'date-fns'
import clsx from 'clsx'
import PeriodSelector, { CARD_PERIODS, PERIOD_DAYS } from '../components/PeriodSelector'
import SegmentedControl from '../components/ios/SegmentedControl'
import { useNavBar } from '../navigation/useNavBar'
import { portfolioApiPeriod, PORTFOLIO_PERIODS } from '../utils/portfolioChart'
import toast from 'react-hot-toast'
import { hasCatalogueImage, resolveCardImageUrl } from '../utils/imageUrl'
import MoneyInput from '../components/MoneyInput'
import { parseMoneyInputValue } from '../utils/moneyInput'

const NAV_BAR = {}

const RARITY_COLORS = [
  '#EF1515', '#3b82f6', '#22c55e', '#eab308', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
]

const PRODUCT_TYPES = ['Booster Pack', 'Booster Box', 'Elite Trainer Box', 'Tin', 'Bundle', 'Collection Box', 'Blister', 'Other']

function CustomTooltip({ active, payload, label, formatPrice }) {
  if (active && payload && payload.length) {
    return (
      <div className="bg-bg-surface border border-border rounded-lg p-3 text-sm shadow-xl">
        <p className="text-text-muted mb-1">{label}</p>
        {payload.map((entry, i) => (
          <p key={i} style={{ color: entry.color }} className="font-medium">
            {entry.name}: {typeof entry.value === 'number' ? formatPrice(entry.value) : entry.value}
          </p>
        ))}
        {payload[0]?.payload?.legacy && (
          <p className="mt-1 text-[10px] text-text-muted">{payload[0].payload.legacyLabel}</p>
        )}
      </div>
    )
  }
  return null
}

// Tap popover for the product-value note (was a hover tooltip on Home).
function ProductValueNote({ label, explanation }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    const close = (event) => {
      if (event.type === 'keydown' ? event.key === 'Escape' : !rootRef.current?.contains(event.target)) setOpen(false)
    }
    window.addEventListener('keydown', close)
    window.addEventListener('pointerdown', close)
    return () => {
      window.removeEventListener('keydown', close)
      window.removeEventListener('pointerdown', close)
    }
  }, [open])

  return (
    <span ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="ios-press inline-flex h-8 w-8 items-center justify-center rounded-full text-yellow focus-visible:outline-2 focus-visible:outline-tint"
      >
        <Info size={16} aria-hidden="true" />
      </button>
      {open && (
        <span
          role="note"
          className="absolute right-0 top-full z-30 mt-1 block w-[min(18rem,calc(100vw-2rem))] rounded-xl border border-hairline bg-card px-3 py-2 text-left text-footnote text-text-secondary shadow-xl"
        >
          {explanation}
        </span>
      )}
    </span>
  )
}

function AddExpenseModal({ onClose, onSuccess }) {
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [productType, setProductType] = useState('Booster Pack')
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const queryClient = useQueryClient()

  const { t, exchangeRate, exchangeRateReady } = useSettings()
  const mutation = useMutation({
    mutationFn: (data) => createProduct(data),
    onSuccess: () => {
      toast.success(t('analytics.expenseSaved'))
      queryClient.invalidateQueries({ queryKey: ['investment-tracker'] })
      queryClient.invalidateQueries({ queryKey: ['products'] })
      onSuccess && onSuccess()
      onClose()
    },
    onError: () => toast.error(t('analytics.expenseSaveError')),
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!exchangeRateReady || !amount || parseFloat(amount) <= 0) return
    mutation.mutate({
      product_name: description.trim() || productType,
      product_type: productType,
      purchase_price: parseMoneyInputValue(amount, exchangeRate),
      purchase_date: date,
      notes: description.trim() || null,
    })
  }

  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/60 flex items-end md:items-center justify-center md:bg-black/80 md:backdrop-blur-(--blur-radius-edge) md:[@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none"
      onClick={onClose}>
      <div className={[
        'w-full rounded-t-2xl max-h-[90dvh] overflow-y-auto',
        'bg-bg-surface border-t border-border',
        'md:rounded-2xl md:border md:max-w-md md:max-h-[80vh]',
      ].join(' ')} onClick={e => e.stopPropagation()}>
        <div className="flex justify-center pt-3 pb-1 md:hidden">
          <div className="w-10 h-1 bg-border rounded-full" />
        </div>
        <div className="p-6">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <ShoppingCart size={18} className="text-brand-red" />
              <h2 className="text-lg font-bold text-text-primary">{t('analytics.logExpense')}</h2>
            </div>
            <button onClick={onClose} className="text-text-muted hover:text-text-primary transition-colors">
              <X size={20} />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-xs text-text-secondary mb-1 block font-medium">
                {t('analytics.amountLabel')} <span className="text-brand-red">*</span>
              </label>
              <MoneyInput
                min="0.01"
                required
                placeholder={t('analytics.amountPlaceholder')}
                value={amount}
                onChange={e => setAmount(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-text-secondary mb-1 block font-medium">{t('products.productType')}</label>
              <select value={productType} onChange={e => setProductType(e.target.value)} className="select">
                {PRODUCT_TYPES.map(pt => <option key={pt} value={pt}>{pt}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-text-secondary mb-1 block font-medium">{t('common.date')}</label>
              <input
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
                className="input"
              />
            </div>
            <div>
              <label className="text-xs text-text-secondary mb-1 block font-medium">{t('analytics.descriptionOptional')}</label>
              <input
                type="text"
                placeholder={t('analytics.descriptionPlaceholder')}
                value={description}
                onChange={e => setDescription(e.target.value)}
                className="input"
              />
            </div>
            <div className="flex gap-3 pt-2">
              <button type="submit" disabled={mutation.isPending || !amount || !exchangeRateReady} className="btn-primary flex-1">
                <Plus size={16} /> {mutation.isPending ? t('analytics.saving') : t('analytics.saveExpense')}
              </button>
              <button type="button" onClick={onClose} className="btn-ghost">{t('common.cancel')}</button>
            </div>
          </form>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default function Analytics() {
  const { t, formatPrice, pricePrimaryField, currencySymbol, settings, updateSettings } = useSettings()
  useNavBar(NAV_BAR)
  const [moversPeriod, setMoversPeriod] = useState('7d')
  const [moversSort, setMoversSort] = useState('percentage')
  const [chartPeriod, setChartPeriod] = useState('MAX')
  const [activeTab, setActiveTab] = useState('investment')
  const [showExpenseModal, setShowExpenseModal] = useState(false)
  const [selectedCard, setSelectedCard] = useState(null)
  const [selectedImageSource, setSelectedImageSource] = useState('catalogue')
  const selectedPhotoItem = selectedCard?.collection_item_id ? {
    id: selectedCard.collection_item_id,
    card_id: selectedCard.card_id,
    has_scan_photo: selectedCard.has_scan_photo,
  } : null
  const selectedOwnPhotoUrl = useCollectionPhotoUrl(selectedPhotoItem, { eager: true })
  const selectedOwnPhotoDefault = showsOwnPhoto(
    selectedPhotoItem,
    selectedCard,
    settings.prefer_own_card_photos === 'true',
  )
  const selectedHasCatalogueImage = hasCatalogueImage(selectedCard) || Boolean(selectedCard?.custom_image_url)
  const selectedImage = selectedImageSource === 'own' && selectedOwnPhotoUrl
    ? selectedOwnPhotoUrl
    : resolveCardImageUrl(selectedCard, 'large')

  useEffect(() => {
    setSelectedImageSource(selectedOwnPhotoDefault ? 'own' : 'catalogue')
  }, [selectedCard?.card_id, selectedOwnPhotoDefault])
  const queryClient = useQueryClient()
  const { data: duplicates = [], isLoading: dupLoading } = useQuery({
    queryKey: ['duplicates', pricePrimaryField],
    queryFn: () => getDuplicates({ price_field: pricePrimaryField }).then(r => r.data),
  })

  const moversDay = PERIOD_DAYS[moversPeriod] || 7
  const { data: topMovers = [], isLoading: moversLoading } = useQuery({
    queryKey: ['top-movers', moversDay, pricePrimaryField, moversSort],
    queryFn: () => getTopMovers(moversDay, { price_field: pricePrimaryField, sort_by: moversSort }).then(r => r.data),
  })

  const { data: rarityStats = [], isLoading: rarityLoading } = useQuery({
    queryKey: ['rarity-stats', pricePrimaryField],
    queryFn: () => getRarityStats({ price_field: pricePrimaryField }).then(r => r.data),
  })

  const { data: investmentData = [], isLoading: investLoading } = useQuery({
    queryKey: ['investment-tracker', chartPeriod, pricePrimaryField],
    queryFn: () => getInvestmentTracker({ period: portfolioApiPeriod(chartPeriod), price_field: pricePrimaryField }).then(r => r.data),
  })

  // The headline numbers Home used to show: the same dashboard query and fields.
  const { data: dashboard } = useQuery({
    queryKey: ['dashboard', pricePrimaryField],
    queryFn: () => getDashboard({ price_field: pricePrimaryField }).then(r => r.data),
    refetchInterval: 60000,
  })

  const { data: tradeStats = null } = useQuery({
    queryKey: ['trade-stats'],
    queryFn: () => getTradeStats().then(r => r.data),
  })

  const { data: products = [] } = useQuery({
    queryKey: ['products', pricePrimaryField],
    queryFn: () => getProducts({ price_field: pricePrimaryField }).then(r => r.data),
  })

  const { data: newSets = [] } = useQuery({
    queryKey: ['analytics-new-sets'],
    queryFn: () => getAnalyticsNewSets().then(r => r.data),
  })

  const tabs = useMemo(() => [
    { value: 'investment', label: t('analytics.investment') },
    { value: 'movers', label: t('analytics.segMovers') },
    { value: 'rarity', label: t('analytics.segRarity') },
    { value: 'duplicates', label: t('analytics.duplicates') },
  ], [t])

  const chartData = investmentData.map(s => ({
    date: format(parseISO(s.date), 'MMM d'),
    value: s.value,
    cost: s.cost,
    pnl: s.pnl,
    legacy: Boolean(s.legacy),
    legacyLabel: t('home.legacySnapshot'),
  }))

  // Investment summary
  const latestSnapshot = investmentData.length > 0 ? investmentData[investmentData.length - 1] : null
  const totalProductsCost = products.reduce((sum, p) => sum + (p.purchase_price || 0), 0)
  const performanceCostBasis = latestSnapshot?.performance_cost_basis ?? latestSnapshot?.cost ?? 0
  const realizedValue = latestSnapshot?.realized_value ?? 0
  const totalPnl = latestSnapshot?.pnl ?? 0
  const hasTradeStats = tradeStats && tradeStats.trade_count > 0

  // Headline block (formerly on Home): value or capital, P&L, realized P&L and the product-value note.
  const headTotalValue = Number(dashboard?.total_value ?? 0)
  const headTotalCost = Number(dashboard?.total_cost ?? 0)
  const headCostBasis = Number(dashboard?.performance_cost_basis ?? headTotalCost)
  const headPnl = Number(dashboard?.pnl ?? 0)
  const headPnlPct = headCostBasis > 0 ? (headPnl / headCostBasis) * 100 : 0
  const headPnlPositive = headPnl >= 0
  const headRealizedPnl = Number(dashboard?.realized_pnl ?? 0)
  const headRealizedValue = Number(dashboard?.realized_value ?? 0)
  const displayMode = settings?.portfolio_display_mode === 'capital_invested' ? 'capital_invested' : 'portfolio_value'
  const showingPortfolioValue = displayMode === 'portfolio_value'
  const headlineValue = showingPortfolioValue ? headTotalValue : headTotalCost
  const headlineLabel = showingPortfolioValue ? t('home.portfolioValue') : t('home.capitalInvested')
  const headFallbackCount = Number(dashboard?.product_value_fallback_count ?? 0)
  const headReviewCount = Number(dashboard?.products_needing_review_count ?? 0)
  const productValueExplanation = [
    headReviewCount > 0 ? `${headReviewCount} ${t('home.productsNeedReview')}` : '',
    headFallbackCount > 0 ? `${headFallbackCount} ${t('home.productValueFallback')}` : '',
  ].filter(Boolean).join(' ')
  const setDisplayMode = (mode) => {
    if (mode === displayMode) return
    updateSettings({ portfolio_display_mode: mode }).catch(() => toast.error(t('home.displayModeSaveFailed')))
  }

  return (
    <div className="space-y-4 pb-2">
      <div>
        <h1 className="sr-only">{t('analytics.title')}</h1>
        <p className="text-footnote text-text-secondary">{t('analytics.subtitle')}</p>
      </div>

      {newSets.length > 0 && (
        <div className="card border-yellow/30 bg-yellow/5">
          <p className="text-sm font-medium text-yellow">
            🆕 {newSets.length} {newSets.length === 1 ? t('analytics.newSet') : t('analytics.newSets')} {t('analytics.newSetsDetected')}: {newSets.map(s => s.name).join(', ')}
          </p>
        </div>
      )}

      <SegmentedControl
        size="md"
        ariaLabel={t('analytics.segmentsLabel')}
        options={tabs}
        value={activeTab}
        onChange={setActiveTab}
      />

      {/* Duplicates Tab */}
      {activeTab === 'duplicates' && (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">{t('analytics.duplicatesDesc')}</p>
          {dupLoading ? (
            <div className="skeleton h-64 rounded-xl" />
          ) : duplicates.length === 0 ? (
            <div className="card text-center py-12 text-text-muted">{t('analytics.noDuplicates')}</div>
          ) : (
            <div className="card p-0 overflow-hidden">
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-bg/50">
                      <th className="text-left px-4 py-3 text-text-muted font-medium">{t('analytics.card')}</th>
                      <th className="text-left px-4 py-3 text-text-muted font-medium">{t('common.set')}</th>
                      <th className="text-left px-4 py-3 text-text-muted font-medium">{t('common.rarity')}</th>
                      <th className="text-center px-4 py-3 text-text-muted font-medium">{t('analytics.qty')}</th>
                      <th className="text-right px-4 py-3 text-text-muted font-medium">{t('analytics.market')}</th>
                      <th className="text-right px-4 py-3 text-text-muted font-medium">{t('analytics.totalValue')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {duplicates.map((item) => (
                      <tr key={item.id} className="border-b border-border/50 hover:bg-bg-elevated/50">
                        <td className="px-4 py-3">
                          <CollectionCardIdentity
                            item={item}
                            name={item.name}
                            onClick={() => setSelectedCard({ ...item, collection_item_id: item.id, id: item.card_id || item.id })}
                          />
                        </td>
                        <td className="px-4 py-3 text-text-secondary text-xs">{item.set_name || '-'}</td>
                        <td className="px-4 py-3 text-text-secondary text-xs">{item.rarity || '-'}</td>
                        <td className="px-4 py-3 text-center font-bold text-brand-red">{item.quantity}x</td>
                        <td className="px-4 py-3 text-right text-text-primary">{formatPrice(item.price_market)}</td>
                        <td className="px-4 py-3 text-right font-bold text-green">{formatPrice(item.total_value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="md:hidden space-y-2 p-2">
                {duplicates.map((item) => (
                  <CollectionCardRow
                    key={item.id}
                    item={item}
                    name={item.name}
                    subtext={item.set_name || '-'}
                    badges={[
                      { label: `${item.quantity}x`, variant: 'red' },
                      ...(item.rarity ? [{ label: item.rarity, variant: 'gray' }] : []),
                    ]}
                    value={formatPrice(item.total_value)}
                    valueSecondary={formatPrice(item.price_market)}
                    onClick={() => setSelectedCard({ ...item, collection_item_id: item.id, id: item.card_id || item.id })}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Top Movers Tab */}
      {activeTab === 'movers' && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <p className="text-sm text-text-secondary">{t('analytics.moversDesc')} {moversDay} {t('analytics.days')}</p>
            <PeriodSelector value={moversPeriod} onChange={setMoversPeriod} periods={CARD_PERIODS} />
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-text-muted">{t('analytics.sortBy')}</span>
              <div className="flex rounded-lg border border-border bg-bg-surface p-0.5">
                {[
                  { value: 'percentage', label: t('analytics.sortPercentage') },
                  { value: 'absolute', label: currencySymbol },
                ].map(option => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setMoversSort(option.value)}
                    aria-pressed={moversSort === option.value}
                    className={clsx(
                      'min-w-10 px-3 py-1.5 rounded-md text-xs font-semibold transition-colors',
                      moversSort === option.value
                        ? 'bg-brand-red text-white'
                        : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {moversLoading ? (
            <div className="skeleton h-64 rounded-xl" />
          ) : topMovers.length === 0 ? (
            <div className="card text-center py-12 text-text-muted">{t('analytics.noMovers')}</div>
          ) : (
            <div className="space-y-2">
              {topMovers.map((card) => (
                <CollectionCardRow
                  key={card.card_id}
                  item={{
                    id: card.collection_item_id,
                    card_id: card.card_id,
                    has_scan_photo: card.has_scan_photo,
                  }}
                  card={card}
                  name={card.name}
                  subtext={card.rarity}
                  onClick={() => setSelectedCard({ ...card, id: card.card_id })}
                  rightAction={(
                    <div className="flex-shrink-0 text-right">
                      <p className="text-sm text-text-secondary">{formatPrice(card.old_price)} → {formatPrice(card.current_price)}</p>
                      <div className={clsx(
                        'flex items-center justify-end gap-1 font-bold',
                        card.change_pct >= 0 ? 'text-green' : 'text-brand-red'
                      )}>
                        {card.change_pct >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                        {card.change_pct >= 0 ? '+' : ''}{card.change_pct}%
                        <span className="ml-1 text-xs font-normal">
                          ({card.change_abs >= 0 ? '+' : ''}{formatPrice(card.change_abs)})
                        </span>
                      </div>
                    </div>
                  )}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Rarity Stats Tab */}
      {activeTab === 'rarity' && (
        <div className="space-y-4">
          {rarityLoading ? (
            <div className="skeleton h-64 rounded-xl" />
          ) : rarityStats.length === 0 ? (
            <div className="card text-center py-12 text-text-muted">{t('analytics.noRarityStats')}</div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="card">
                <h3 className="text-base font-semibold text-text-primary mb-4">{t('analytics.byCount')}</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie data={rarityStats} dataKey="count" nameKey="rarity" cx="50%" cy="50%" outerRadius={100}
                      label={({ rarity, percentage }) => `${percentage}%`}>
                      {rarityStats.map((_, i) => <Cell key={i} fill={RARITY_COLORS[i % RARITY_COLORS.length]} />)}
                    </Pie>
                    <Tooltip
                      contentStyle={{ background: '#1e1e2e', border: '1px solid #2a2a3d', borderRadius: '8px', color: '#fff' }}
                      labelStyle={{ color: '#fff' }}
                      itemStyle={{ color: '#fff' }}
                      formatter={(val, name) => [val, t('analytics.count')]}
                    />
                    <Legend wrapperStyle={{ color: '#a0a0b8' }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="card">
                <h3 className="text-base font-semibold text-text-primary mb-4">{t('analytics.byValue')}</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={rarityStats} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3d" horizontal={false} />
                    <XAxis type="number" tick={{ fill: '#606078', fontSize: 11 }} tickFormatter={v => formatPrice(v)} />
                    <YAxis dataKey="rarity" type="category" tick={{ fill: '#606078', fontSize: 10 }} width={100} />
                    <Tooltip content={<CustomTooltip formatPrice={formatPrice} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <Bar dataKey="total_value" name={t('analytics.value')} radius={[0, 4, 4, 0]}>
                      {rarityStats.map((_, i) => <Cell key={i} fill={RARITY_COLORS[i % RARITY_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {/* Table */}
              <div className="card lg:col-span-2">
                <div className="hidden sm:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border">
                        <th className="text-left py-2 text-text-muted">{t('common.rarity')}</th>
                        <th className="text-right py-2 text-text-muted">{t('analytics.count')}</th>
                        <th className="text-right py-2 text-text-muted">{t('analytics.percentage')}</th>
                        <th className="text-right py-2 text-text-muted">{t('analytics.totalValue')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rarityStats.map((r, i) => (
                        <tr key={r.rarity} className="border-b border-border/30 hover:bg-bg-elevated/50">
                          <td className="py-2 flex items-center gap-2">
                            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: RARITY_COLORS[i % RARITY_COLORS.length] }} />
                            <span className="text-text-primary">{r.rarity}</span>
                          </td>
                          <td className="py-2 text-right text-text-secondary">{r.count}</td>
                          <td className="py-2 text-right text-text-secondary">{r.percentage}%</td>
                          <td className="py-2 text-right text-green font-medium">{formatPrice(r.total_value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="sm:hidden space-y-2">
                  {rarityStats.map((r, i) => (
                    <div key={r.rarity} className="flex items-center gap-3 py-2 border-b border-border/30">
                      <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: RARITY_COLORS[i % RARITY_COLORS.length] }} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-text-primary break-words">{r.rarity}</p>
                        <p className="text-xs text-text-secondary">{r.count} · {r.percentage}%</p>
                      </div>
                      <p className="text-green font-medium text-sm flex-shrink-0">{formatPrice(r.total_value)}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Investment Tracker Tab */}
      {activeTab === 'investment' && (
        <div className="space-y-4">
          {/* Period, display mode and headline figures: the value block that left Home. */}
          <SegmentedControl
            ariaLabel={t('analytics.periodLabel')}
            options={PORTFOLIO_PERIODS.map(p => ({ value: p.key, label: p.label }))}
            value={chartPeriod}
            onChange={setChartPeriod}
          />
          <SegmentedControl
            ariaLabel={t('home.portfolioDisplayMode')}
            options={[
              { value: 'portfolio_value', label: t('home.portfolioValue') },
              { value: 'capital_invested', label: t('home.capitalInvested') },
            ]}
            value={displayMode}
            onChange={setDisplayMode}
          />
          <div className="card text-center space-y-2" data-testid="analytics-headline">
            <div className="flex items-center justify-center gap-1">
              <p className="text-footnote text-text-secondary">{headlineLabel}</p>
              {showingPortfolioValue && productValueExplanation && (
                <ProductValueNote label={`${headlineLabel}: ${t('home.details')}`} explanation={productValueExplanation} />
              )}
            </div>
            <p className="text-4xl font-black tracking-tight" style={{ color: showingPortfolioValue ? '#f5c842' : '#4fc3f7' }}>
              {formatPrice(headlineValue)}
            </p>
            <div className="flex flex-col items-center gap-1.5">
              <div
                className="flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-black"
                style={{
                  background: headPnlPositive ? 'rgba(102,187,106,0.12)' : 'rgba(227,0,11,0.12)',
                  color: headPnlPositive ? '#66bb6a' : '#e3000b',
                }}
              >
                {headPnlPositive ? <TrendingUp size={15} /> : <TrendingDown size={15} />}
                <span>{headPnlPositive ? '+' : ''}{formatPrice(headPnl)}</span>
                {headCostBasis > 0 && <span className="opacity-75">({headPnlPositive ? '+' : ''}{headPnlPct.toFixed(1)}%)</span>}
              </div>
              {(headRealizedValue > 0 || headRealizedPnl !== 0) && (
                <span
                  className="rounded-full px-2.5 py-1 text-footnote font-semibold"
                  style={{
                    background: headRealizedPnl >= 0 ? 'rgba(102,187,106,0.1)' : 'rgba(227,0,11,0.1)',
                    color: headRealizedPnl >= 0 ? '#66bb6a' : '#e3000b',
                  }}
                >
                  {t('analytics.realizedPnl')}: {headRealizedPnl >= 0 ? '+' : '-'}{formatPrice(Math.abs(headRealizedPnl))}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <p className="text-sm text-text-secondary">{t('analytics.portfolioDesc')}</p>
              {latestSnapshot && (
                <p className="text-xs text-text-muted mt-0.5">
                  {t('analytics.current')}: <span className="text-green font-bold">{formatPrice(latestSnapshot.value)}</span>
                  {' · '}{t('dashboard.invested')}: <span className="text-text-primary font-medium">{formatPrice(latestSnapshot.cost)}</span>
                  {Number(latestSnapshot.products_value ?? 0) > 0 && (
                    <> · {t('analytics.products')}: <span className="text-yellow font-medium">{formatPrice(latestSnapshot.products_value)}</span></>
                  )}
                </p>
              )}
            </div>
            <button
              onClick={() => setShowExpenseModal(true)}
              className="btn-ghost text-sm py-1.5 border-green/30 text-green hover:bg-green/10"
            >
              <ShoppingCart size={14} /> {t('analytics.logExpense')}
            </button>
          </div>

          {/* Summary stats use the same versioned portfolio calculation as the dashboard. */}
          {(products.length > 0 || latestSnapshot) && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {[
                { label: t('analytics.trackedCost'), value: formatPrice(performanceCostBasis), color: '#90a4ae' },
                { label: t('home.portfolioValue'), value: formatPrice(latestSnapshot?.value ?? 0), color: '#f5c842' },
                { label: t('analytics.trackedProceeds'), value: formatPrice(realizedValue), color: '#66bb6a' },
                { label: t('analytics.totalPnl'), value: formatPrice(totalPnl), color: totalPnl >= 0 ? '#66bb6a' : '#e3000b' },
              ].map(stat => (
                <div key={stat.label} className="rounded-xl p-3 text-center"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                  <p className="text-xs text-text-muted mb-1 leading-tight">{stat.label}</p>
                  <p className="text-sm font-black" style={{ color: stat.color }}>{stat.value}</p>
                </div>
              ))}
            </div>
          )}

          {chartData.some(point => point.legacy) && (
            <p className="rounded-lg border border-border bg-bg-elevated/40 px-3 py-2 text-xs text-text-muted">
              {t('analytics.legacySnapshotNotice')}
            </p>
          )}

          {hasTradeStats && (
            <div className="card space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-text-primary">{t('analytics.tradeStats')}</h3>
                  <p className="text-xs text-text-muted mt-0.5">{t('analytics.tradeStatsDesc')}</p>
                </div>
                <div className="px-2.5 py-1 rounded-md bg-bg-elevated border border-border text-xs font-bold text-text-primary">
                  {tradeStats.trade_count} {tradeStats.trade_count === 1 ? t('analytics.trade') : t('analytics.trades')}
                </div>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
                {[
                  {
                    label: t('analytics.tradeValueDelta'),
                    value: formatPrice(tradeStats.value_delta),
                    color: tradeStats.value_delta >= 0 ? '#66bb6a' : '#e3000b',
                  },
                  {
                    label: t('analytics.tradeCardsMoved'),
                    value: `${tradeStats.outgoing_card_quantity} / ${tradeStats.incoming_card_quantity}`,
                    color: '#90a4ae',
                  },
                  {
                    label: t('analytics.tradeCashNet'),
                    value: formatPrice(tradeStats.cash_delta),
                    color: tradeStats.cash_delta >= 0 ? '#66bb6a' : '#e3000b',
                  },
                  {
                    label: t('analytics.tradeProductLocked'),
                    value: formatPrice(tradeStats.product_locked_value),
                    color: '#facc15',
                  },
                ].map(stat => (
                  <div key={stat.label} className="rounded-xl p-3 text-center bg-bg-elevated/60 border border-border/70">
                    <p className="text-xs text-text-muted mb-1 leading-tight">{stat.label}</p>
                    <p className="text-sm font-black" style={{ color: stat.color }}>{stat.value}</p>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                <div className="rounded-xl bg-bg-elevated/40 border border-border/60 p-3">
                  <p className="text-xs uppercase text-text-muted mb-2">{t('analytics.tradeGiven')}</p>
                  <div className="flex justify-between gap-3">
                    <span className="text-text-secondary">{t('analytics.tradeCards')}</span>
                    <span className="font-semibold text-text-primary">{formatPrice(tradeStats.outgoing_card_value)}</span>
                  </div>
                  <div className="flex justify-between gap-3 mt-1">
                    <span className="text-text-secondary">{t('analytics.tradeCash')}</span>
                    <span className="font-semibold text-brand-red">{formatPrice(tradeStats.outgoing_cash)}</span>
                  </div>
                </div>
                <div className="rounded-xl bg-bg-elevated/40 border border-border/60 p-3">
                  <p className="text-xs uppercase text-text-muted mb-2">{t('analytics.tradeReceived')}</p>
                  <div className="flex justify-between gap-3">
                    <span className="text-text-secondary">{t('analytics.tradeCards')}</span>
                    <span className="font-semibold text-text-primary">{formatPrice(tradeStats.incoming_card_value)}</span>
                  </div>
                  <div className="flex justify-between gap-3 mt-1">
                    <span className="text-text-secondary">{t('analytics.tradeCash')}</span>
                    <span className="font-semibold text-green">{formatPrice(tradeStats.incoming_cash)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {investLoading ? (
            <div className="skeleton h-64 rounded-xl" />
          ) : chartData.length === 0 ? (
            <div className="card text-center py-12 space-y-3">
              <p className="text-text-muted">{t('analytics.noInvestmentData')}</p>
              <button onClick={() => setShowExpenseModal(true)} className="btn-ghost text-green border-green/30 hover:bg-green/10 mx-auto text-sm">
                <ShoppingCart size={14} /> {t('analytics.logFirst')}
              </button>
            </div>
          ) : (
            <>
              <div className="card">
                <h3 className="text-base font-semibold text-text-primary mb-4">{t('analytics.portfolioValue')}</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart data={chartData}>
                    <defs>
                      <linearGradient id="valueGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#EF1515" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#EF1515" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="costGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#606078" stopOpacity={0.2} />
                        <stop offset="95%" stopColor="#606078" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3d" />
                    <XAxis dataKey="date" tick={{ fill: '#606078', fontSize: 11 }} />
                    <YAxis tick={{ fill: '#606078', fontSize: 11 }} tickFormatter={v => formatPrice(v)} />
                    <Tooltip content={<CustomTooltip formatPrice={formatPrice} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <Area type="monotone" dataKey="cost" name={t('analytics.cost')} stroke="#606078" fill="url(#costGrad)" strokeWidth={1.5} strokeDasharray="4 4" />
                    <Area type="monotone" dataKey="value" name={t('analytics.value')} stroke="#EF1515" fill="url(#valueGrad)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="card">
                <h3 className="text-base font-semibold text-text-primary mb-4">{t('analytics.pnlOverTime')}</h3>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2a3d" />
                    <XAxis dataKey="date" tick={{ fill: '#606078', fontSize: 11 }} />
                    <YAxis tick={{ fill: '#606078', fontSize: 11 }} tickFormatter={v => formatPrice(v)} />
                    <Tooltip content={<CustomTooltip formatPrice={formatPrice} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <Bar dataKey="pnl" name={t('analytics.pnl')} radius={[4, 4, 0, 0]}>
                      {chartData.map((entry, i) => (
                        <Cell key={i} fill={entry.pnl >= 0 ? '#22c55e' : '#EF1515'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Product purchases list */}
              {products.length > 0 && (
                <div className="card">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-base font-semibold text-text-primary">{t('analytics.loggedExpenses')}</h3>
                    <button onClick={() => setShowExpenseModal(true)} className="btn-ghost text-xs py-1 px-2 text-green border-green/30">
                      <Plus size={12} /> {t('common.new')}
                    </button>
                  </div>
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {[...products].sort((a,b) => new Date(b.purchase_date) - new Date(a.purchase_date)).map(p => {
                      const isSold = p.sold_price != null
                      const currentValue = p.computed_current_value ?? p.current_value ?? 0
                      const pnl = isSold ? (p.sold_price - p.purchase_price) : (currentValue - p.purchase_price)
                      const pnlPositive = pnl >= 0

                      return (
                        <div key={p.id} className="flex flex-col gap-2 border-b border-border/30 py-2 last:border-0 sm:flex-row sm:items-center sm:justify-between">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-text-primary truncate">{p.product_name}</p>
                            <p className="text-xs text-text-muted">
                              {p.product_type} · {p.purchase_date}
                            </p>
                            {p.value_source === 'purchase_cost_fallback' && (
                              <p className="text-[10px] text-text-muted">{t('products.costFallback')}</p>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-2 sm:ml-2 sm:flex-shrink-0">
                            {isSold ? (
                              <span className="text-xs bg-green/20 text-green px-1.5 py-0.5 rounded">{t('analytics.statusSold')}</span>
                            ) : (
                              <span className="text-xs bg-blue/20 text-blue-400 px-1.5 py-0.5 rounded">{t('analytics.statusOwned')}</span>
                            )}
                            {isSold ? (
                              <span className="text-sm text-text-secondary">{t('analytics.soldFor')} {formatPrice(p.sold_price)}</span>
                            ) : (
                              <span className="text-sm text-text-secondary">{t('products.currentValueLabel')} {formatPrice(currentValue)}</span>
                            )}
                            {pnl != 0 && (
                              <span className={clsx(
                                'text-xs px-1.5 py-0.5 rounded',
                                pnlPositive ? 'bg-green/20 text-green' : 'bg-brand-red/20 text-brand-red'
                              )}>
                                {pnlPositive ? '+' : ''}{formatPrice(pnl)} {pnlPositive ? t('analytics.profit') : t('common.loss')}
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  <div className="border-t border-border pt-2 mt-2 flex justify-between text-sm">
                    <span className="text-text-muted">{t('analytics.totalInvestedProducts')}</span>
                    <span className="font-bold text-brand-red">{formatPrice(totalProductsCost)}</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {showExpenseModal && (
        <AddExpenseModal
          onClose={() => setShowExpenseModal(false)}
          onSuccess={() => queryClient.invalidateQueries({ queryKey: ['investment-tracker'] })}
        />
      )}
      {selectedCard && (
        <CardModal
          card={selectedCard}
          image={selectedImage}
          imageOverlay={selectedImage === selectedOwnPhotoUrl ? <OwnPhotoOverlayBadge t={t} /> : null}
          imageAccessory={selectedOwnPhotoUrl && selectedHasCatalogueImage ? (
            <div className="grid grid-cols-2 gap-2" role="group" aria-label={t('collection.photoSource')}>
              <button
                type="button"
                onClick={() => setSelectedImageSource('catalogue')}
                aria-pressed={selectedImageSource === 'catalogue'}
                className={clsx(
                  'cursor-pointer rounded-lg border px-2 py-2 text-xs font-bold transition-colors',
                  selectedImageSource === 'catalogue'
                    ? 'border-brand-red bg-brand-red/15 text-brand-red'
                    : 'border-border bg-bg-card text-text-secondary hover:bg-bg-elevated',
                )}
              >
                {t('collection.cataloguePhoto')}
              </button>
              <button
                type="button"
                onClick={() => setSelectedImageSource('own')}
                aria-pressed={selectedImageSource === 'own'}
                className={clsx(
                  'cursor-pointer rounded-lg border px-2 py-2 text-xs font-bold transition-colors',
                  selectedImageSource === 'own'
                    ? 'border-brand-red bg-brand-red/15 text-brand-red'
                    : 'border-border bg-bg-card text-text-secondary hover:bg-bg-elevated',
                )}
              >
                {t('collection.myCardPhoto')}
              </button>
            </div>
          ) : null}
          onClose={() => setSelectedCard(null)}
          initialTab="overview"
        />
      )}
    </div>
  )
}
