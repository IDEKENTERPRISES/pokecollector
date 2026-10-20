import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Layers, Grid2X2, Wallet, Heart, Layers3, BarChart3, ScanLine, UploadCloud, Link2, ShoppingBag, Sparkles, Loader2,
} from 'lucide-react'
import toast from 'react-hot-toast'
import { getDashboard, getInvestmentTracker, getScanJobs, getSets, getPokedex, getCustomMatches } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { useAuth } from '../contexts/AuthContext'
import { useOffline } from '../offline/useOffline'
import { useOutbox } from '../offline/useOutbox'
import { collectionItemTargetUrl } from '../utils/navigation'
import { resolveSetImageUrl } from '../utils/imageUrl'
import { CardLegend, withCollectionItemState } from '../components/card-system'
import { CollectionCardDisplay } from '../components/CollectionCardImage'
import SyncSheet from '../components/sync/SyncSheet'
import HeaderBloom from '../components/ios/HeaderBloom'
import HideValuesToggle from '../components/ios/HideValuesToggle'
import LargeTitle from '../components/ios/LargeTitle'
import StatTile from '../components/ios/StatTile'
import SetTile from '../components/ios/SetTile'
import PokeBall from '../components/ios/PokeBall'
import { TYPE_COLOURS } from '../components/ios/pokemon'
import { useNavBar } from '../navigation/useNavBar'
import {
  SCAN_JOBS_QUERY_KEY,
  hasActiveScanJobs,
  scanAttentionCount,
} from '../utils/scanJobs'
import {
  closestToCompleteSets, completeSetCount, minutesSince, seriesChange, shortAge, todoCards, trackerSeries,
} from './homeHelpers'

const NAV_BAR = { trailing: <HideValuesToggle /> }

// Compact number formatter (1.2k, 3.4M, etc.)
function compactNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  return Number(n).toLocaleString()
}

const fill = (template, values) => Object.entries(values).reduce(
  (text, [key, value]) => text.replace(`{${key}}`, value),
  template,
)

function SectionHeader({ title, to, action }) {
  return (
    <div className="mb-2 flex items-baseline justify-between px-0.5">
      <h2 className="text-title-3 font-display text-text-primary">{title}</h2>
      {to && (
        <Link to={to} className="ios-press text-callout text-tint focus-visible:outline-2 focus-visible:outline-tint">
          {action}
        </Link>
      )}
    </div>
  )
}

// A horizontally scrolling row that bleeds to the screen edges inside the 16 px page padding.
function Carousel({ children, label }) {
  return (
    <div role="list" aria-label={label} className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-1 snap-x">
      {children}
    </div>
  )
}

function CardThumb({ card, onClick, rank, price }) {
  return (
    <div role="listitem" className="w-[118px] flex-shrink-0 snap-start">
      <div className="holo relative rounded-lg">
        <CollectionCardDisplay
          variant="artwork"
          item={{ id: card.collection_item_id, has_scan_photo: card.has_scan_photo }}
          card={card}
          alt={card.name}
          variantEffectSource={card.variant}
          interactive
          onClick={onClick}
          stateIndicatorProps={{ card: withCollectionItemState(card, card), alwaysShowQuantity: true }}
        />
        {rank != null && (
          <span className="absolute bottom-1 left-1 z-20 rounded bg-black/85 px-1 text-caption-2 font-bold leading-4 text-yellow">
            #{rank}
          </span>
        )}
      </div>
      {price != null && (
        <p className="mt-1 truncate text-caption-1 font-semibold tabular-nums text-yellow">{price}</p>
      )}
    </div>
  )
}

function TodoCard({ type, icon: Icon, title, detail, action, to, onClick }) {
  const { text, top, bottom } = TYPE_COLOURS[type]
  const style = { color: text, background: `linear-gradient(150deg, ${top}, ${bottom})` }
  const body = (
    <>
      <span className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-full bg-black/20" aria-hidden="true">
        <Icon size={20} className={Icon === Loader2 ? 'motion-safe:animate-spin' : ''} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-headline">{title}</span>
        <span className="block text-footnote opacity-90">{detail}</span>
      </span>
      <span className="flex-shrink-0 rounded-full bg-black/25 px-3.5 py-1.5 text-subheadline font-semibold">{action}</span>
    </>
  )
  const classes = 'ios-press no-callout flex min-h-[64px] w-full items-center gap-3 rounded-[18px] p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tint'
  if (to) return <Link to={to} className={classes} style={style}>{body}</Link>
  return <button type="button" onClick={onClick} className={classes} style={style}>{body}</button>
}

function QuickAction({ to, icon: Icon, label, type }) {
  const { solid, text } = TYPE_COLOURS[type]
  return (
    <Link to={to} className="ios-press no-callout flex min-w-0 flex-col items-center gap-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tint">
      <span
        className="grid h-14 w-14 place-items-center rounded-full"
        style={{ background: solid, color: text === '#FFFFFF' ? '#fff' : text, boxShadow: `0 6px 14px color-mix(in srgb, ${solid} 50%, transparent)` }}
        aria-hidden="true"
      >
        <Icon size={24} />
      </span>
      <span className="max-w-full truncate text-footnote text-text-primary">{label}</span>
    </Link>
  )
}

export default function HomeScreen() {
  const navigate = useNavigate()
  const { formatPrice, t, pricePrimaryField, settings, updateSettings } = useSettings()
  const { user } = useAuth()
  const offline = useOffline()
  const { enabled: queueEnabled, items: outboxItems } = useOutbox()
  const [syncOpen, setSyncOpen] = useState(false)
  const language = settings.language === 'de' ? 'de' : 'en'

  useNavBar(NAV_BAR)

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', pricePrimaryField],
    queryFn: () => getDashboard({ price_field: pricePrimaryField }).then(r => r.data),
    refetchInterval: 60000,
  })

  const { data: scanData } = useQuery({
    queryKey: SCAN_JOBS_QUERY_KEY,
    queryFn: getScanJobs,
    refetchInterval: query => hasActiveScanJobs(query.state.data?.jobs || []) ? 3000 : false,
  })
  const scanJobs = scanData?.jobs || []
  const scanAttention = scanAttentionCount(scanJobs)
  const scansActive = hasActiveScanJobs(scanJobs)

  // Same keys as the Sets page and Profile, so the read cache and the other pages share them.
  const { data: tracker = [] } = useQuery({
    queryKey: ['investment-tracker', '1M', pricePrimaryField],
    queryFn: () => getInvestmentTracker({ period: '1m', price_field: pricePrimaryField }).then(r => r.data),
    refetchInterval: 120000,
  })
  const { data: sets = [] } = useQuery({
    queryKey: ['sets', 'all'],
    queryFn: () => getSets({ lang: 'all' }).then(r => r.data),
  })
  const { data: pokedexSummary } = useQuery({
    queryKey: ['pokedex-summary', language],
    queryFn: () => getPokedex({ lang: language, status: 'all' }).then(result => result?.summary ?? null),
    staleTime: 60 * 60 * 1000,
    enabled: !offline,
    retry: false,
  })
  const { data: customMatches = [] } = useQuery({
    queryKey: ['custom-matches'],
    queryFn: () => getCustomMatches().then(r => r.data),
    enabled: !offline,
    retry: false,
  })

  const trainerName = user?.username || 'Trainer'

  const portfolioDisplayMode = settings?.portfolio_display_mode === 'capital_invested' ? 'capital_invested' : 'portfolio_value'
  const showingPortfolioValue = portfolioDisplayMode === 'portfolio_value'
  const headlineValue = showingPortfolioValue ? Number(data?.total_value ?? 0) : Number(data?.total_cost ?? 0)
  const headlineLabel = showingPortfolioValue ? t('home.portfolioValue') : t('home.capitalInvested')

  const toggleDisplayMode = () => {
    const next = showingPortfolioValue ? 'capital_invested' : 'portfolio_value'
    updateSettings({ portfolio_display_mode: next }).catch(() => {
      toast.error(t('home.displayModeSaveFailed'))
    })
  }

  const series = useMemo(
    () => trackerSeries(tracker, showingPortfolioValue ? 'value' : 'cost'),
    [tracker, showingPortfolioValue],
  )
  const change = seriesChange(series)
  const changeText = change == null ? null : `${change > 0 ? '+' : ''}${formatPrice(change)} ${t('home.thisMonth')}`

  const completeSets = useMemo(() => completeSetCount(sets), [sets])
  const yourSets = useMemo(() => closestToCompleteSets(sets), [sets])

  const todos = todoCards({
    scanAttention,
    scansActive,
    queueEnabled,
    outboxCount: outboxItems.length,
    customMatches: customMatches.length,
    productsToReview: Number(data?.products_needing_review_count ?? 0),
    newSets: Number(data?.new_sets_count ?? 0),
  })

  const age = shortAge(minutesSince(data?.last_sync?.finished_at))

  const recentCards = data?.recent_additions?.slice(0, 12) ?? []
  const topCards = data?.top_cards?.slice(0, 8) ?? []
  const openCollectionItem = (card) => navigate(collectionItemTargetUrl(card))

  const todoView = {
    'scans-review': { type: 'lightning', icon: ScanLine, title: 'todoScansReview', detail: 'todoScansReviewDetail', action: 'todoReview', to: '/scans' },
    'scans-processing': { type: 'psychic', icon: Loader2, title: 'todoScansProcessing', detail: 'todoScansProcessingDetail', action: 'todoOpen', to: '/scans' },
    sync: { type: 'water', icon: UploadCloud, title: 'todoSync', detail: 'todoSyncDetail', action: 'todoOpen', onClick: () => setSyncOpen(true) },
    matches: { type: 'psychic', icon: Link2, title: 'todoMatches', detail: 'todoMatchesDetail', action: 'todoReview', to: '/migration' },
    products: { type: 'fighting', icon: ShoppingBag, title: 'todoProducts', detail: 'todoProductsDetail', action: 'todoReview', to: '/products' },
    'new-sets': { type: 'grass', icon: Sparkles, title: 'todoNewSets', detail: 'todoNewSetsDetail', action: 'todoOpen', to: '/sets' },
  }

  return (
    <div className="relative isolate -mt-1 flex flex-col gap-6 pb-6">
      <HeaderBloom variant="home" />

      <LargeTitle>
        <div className="flex items-center gap-3">
          <span
            className="grid h-16 w-16 flex-shrink-0 place-items-center rounded-full p-[3px]"
            style={{ background: 'linear-gradient(180deg, var(--poke-red) 0 50%, #fff 50% 100%)' }}
          >
            <span className="grid h-full w-full place-items-center overflow-hidden rounded-full bg-black">
              {user?.avatar_id ? (
                <img
                  src={`/api/pokedex/images/sprites/${user.avatar_id}.png`}
                  alt={`${trainerName} avatar`}
                  className="pixelated h-12 w-12"
                />
              ) : (
                <PokeBall size={32} />
              )}
            </span>
          </span>
          <div className="min-w-0">
            <p className="text-subheadline text-text-secondary">{t('home.hello')},</p>
            <p className="truncate text-title-1 font-display text-text-primary">{trainerName}</p>
          </div>
        </div>
      </LargeTitle>

      {recentCards.length > 0 && (
        <section>
          <SectionHeader title={t('home.latestPulls')} to="/collection" action={t('home.viewAll')} />
          <Carousel label={t('home.latestPulls')}>
            {recentCards.map(card => (
              <CardThumb key={card.id} card={card} onClick={() => openCollectionItem(card)} />
            ))}
          </Carousel>
        </section>
      )}

      {(recentCards.length > 0 || topCards.length > 0) && (
        <CardLegend legendProps={{ showWishlist: false }} />
      )}

      <section className="space-y-2">
        <div className="grid grid-cols-2 gap-3">
          <StatTile
            type="fire"
            icon={Layers}
            label={t('home.cardsTotal')}
            value={isLoading ? '—' : compactNum(data?.total_cards ?? 0)}
            detail={isLoading ? undefined : fill(t('home.uniqueCount'), { count: compactNum(data?.unique_cards ?? 0) })}
            to="/collection"
          />
          <StatTile
            type="water"
            icon={Grid2X2}
            label={t('home.sets')}
            value={isLoading ? '—' : compactNum(data?.owned_sets ?? 0)}
            detail={sets.length > 0 ? fill(t('home.completeCount'), { count: completeSets }) : undefined}
            to="/sets"
          />
          {pokedexSummary && (
            <StatTile
              type="grass"
              icon={<PokeBall size={15} top="#fff" />}
              label={t('nav.pokedex')}
              value={`${pokedexSummary.owned}/${pokedexSummary.total}`}
              detail={t('home.caught')}
              to="/pokedex"
            />
          )}
          <StatTile
            type="lightning"
            icon={Wallet}
            label={(
              <button
                type="button"
                onClick={toggleDisplayMode}
                aria-label={`${headlineLabel}. ${t('home.switchValueMode')}`}
                className="ios-press relative z-10 -my-1 min-h-[44px] max-w-full truncate rounded-full bg-black/15 px-2.5 text-footnote font-semibold"
              >
                {headlineLabel}
              </button>
            )}
            value={isLoading ? '—' : formatPrice(headlineValue)}
            detail={changeText}
            sparkline={series}
            className={pokedexSummary ? '' : 'col-span-2'}
          >
            <Link to="/analytics" aria-label={t('nav.analytics')} className="absolute inset-0 z-0 rounded-[22px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tint" />
          </StatTile>
        </div>
        {age && (
          <p className="px-1 text-footnote text-text-secondary">{fill(t('home.pricesUpdated'), { age })}</p>
        )}
      </section>

      {todos.length > 0 && (
        <section className="space-y-2.5">
          {todos.map(({ key, count }) => {
            const view = todoView[key]
            return (
              <TodoCard
                key={key}
                type={view.type}
                icon={view.icon}
                title={fill(t(`home.${view.title}`), { count })}
                detail={t(`home.${view.detail}`)}
                action={t(`home.${view.action}`)}
                to={view.to}
                onClick={view.onClick}
              />
            )
          })}
        </section>
      )}
      {syncOpen && <SyncSheet isOpen onClose={() => setSyncOpen(false)} />}

      <section aria-label={t('home.quickActions')} className="grid grid-cols-4 gap-2">
        <QuickAction to="/wishlist" icon={Heart} label={t('nav.wishlist')} type="fairy" />
        <QuickAction to="/binders" icon={Layers3} label={t('nav.binders')} type="water" />
        <QuickAction to="/sets" icon={Grid2X2} label={t('nav.sets')} type="grass" />
        <QuickAction to="/analytics" icon={BarChart3} label={t('nav.analytics')} type="lightning" />
      </section>

      {yourSets.length > 0 && (
        <section>
          <SectionHeader title={t('home.yourSets')} to="/sets" action={t('home.viewAll')} />
          <Carousel label={t('home.yourSets')}>
            {yourSets.map(set => (
              <div key={set.id} role="listitem" className="w-[168px] flex-shrink-0 snap-start">
                <SetTile
                  set={{ id: set.id, name: set.name, logo: resolveSetImageUrl(set, 'logo'), abbreviation: set.ptcgo_code || set.abbreviation }}
                  owned={set.owned_count ?? 0}
                  total={set.total ?? 0}
                  to={`/sets/${set.id}`}
                />
              </div>
            ))}
          </Carousel>
        </section>
      )}

      {topCards.length > 0 && (
        <section>
          <SectionHeader title={t('home.topCardsShort')} to="/collection?sort=market_price&order=desc" action={t('home.viewAll')} />
          <Carousel label={t('home.topCardsShort')}>
            {topCards.map((card, i) => (
              <CardThumb
                key={card.collection_item_id || card.id}
                card={card}
                rank={i + 1}
                price={formatPrice(Number(card.total_value ?? 0))}
                onClick={() => openCollectionItem(card)}
              />
            ))}
          </Carousel>
        </section>
      )}
    </div>
  )
}
