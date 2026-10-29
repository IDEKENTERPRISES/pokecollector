import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Award, Dna, PartyPopper, Download, Globe, Sparkles, Package, ArrowLeftRight, Trophy, BarChart3, RefreshCw, Settings as SettingsIcon, Users } from 'lucide-react'
import {
  getAchievements,
  getCustomMatches,
  getDashboard,
  getInvestmentTracker,
  getPokedexSummary,
  getProfile,
  getShowcase,
  getTodaySummary,
} from '../api/client'
import { localDateString } from '../progress/checkin'
import GymBadges from '../components/ios/GymBadges'
import HideValuesToggle from '../components/ios/HideValuesToggle'
import LargeTitle from '../components/ios/LargeTitle'
import ListRow from '../components/ios/ListRow'
import ListSection from '../components/ios/ListSection'
import PageSheet from '../components/ios/PageSheet'
import StatTile from '../components/ios/StatTile'
import TrainerCard from '../components/ios/TrainerCard'
import { isIosDevice } from '../components/pwa/InstallHint'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import { useNavBar } from '../navigation/useNavBar'
import { isStandalone } from '../offline/capabilities'
import { useOffline } from '../offline/useOffline'
import { useOutbox } from '../offline/useOutbox'
import { readPwaFlags } from '../pwa/flags'
import ShowcasePicker from '../delights/ShowcasePicker'
import { SHOWCASE_MAX, fill } from '../delights/delights'
import { useWrapped } from '../wrapped/useWrapped'
import { wrappedYearFor } from '../wrapped/wrapped'

const NAV_BAR = { trailing: <HideValuesToggle /> }

/**
 * Profile tab root (design doc §5.5): the trainer card, shortcut tiles, the list (Settings, Sync &
 * offline, migration, install, Log out) and the app version. It renders from cached data offline;
 * numbers that are not cached (the Pokédex count) show a dash.
 */
export default function Profile() {
  const { t, settings, pricePrimaryField, formatCompactPrice } = useSettings()
  const { user, logout, multiUser } = useAuth()
  const offline = useOffline()
  const { items } = useOutbox()
  const [installOpen, setInstallOpen] = useState(false)
  const [showcaseOpen, setShowcaseOpen] = useState(false)
  const isAdmin = user?.role === 'admin'
  const publicProfilesEnabled = settings.public_profiles_enabled === 'true'
  const queue = readPwaFlags().queue

  useNavBar(NAV_BAR)

  // Same keys as Home, so the read cache restores them offline.
  const { data: dashboard } = useQuery({
    queryKey: ['dashboard', pricePrimaryField],
    queryFn: () => getDashboard({ price_field: pricePrimaryField }).then(r => r.data),
  })
  const { data: tracker = [] } = useQuery({
    queryKey: ['investment-tracker', '1M', pricePrimaryField],
    queryFn: () => getInvestmentTracker({ period: '1m', price_field: pricePrimaryField }).then(r => r.data),
  })
  const { data: pokedexSummary } = useQuery({
    queryKey: ['pokedex-summary'],
    queryFn: getPokedexSummary,
    staleTime: 24 * 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    enabled: !offline,
    retry: false,
  })
  const { data: profile } = useQuery({
    queryKey: ['profile'],
    queryFn: () => getProfile(),
    enabled: publicProfilesEnabled && !offline,
    retry: false,
  })
  const { data: achievements } = useQuery({
    queryKey: ['achievements', user?.id, pricePrimaryField],
    queryFn: () => getAchievements(user.id, { price_field: pricePrimaryField }).then(r => r.data),
    enabled: Boolean(user?.id),
  })
  const { data: todaySummary } = useQuery({
    queryKey: ['today-card', user?.id, localDateString()],
    queryFn: () => getTodaySummary(localDateString()),
    enabled: Boolean(user?.id),
    staleTime: 30 * 1000,
    retry: false,
  })
  const { data: showcase } = useQuery({
    queryKey: ['showcase'],
    queryFn: getShowcase,
    enabled: Boolean(user?.id),
    retry: false,
  })
  const wrappedYear = wrappedYearFor()
  const { data: wrapped } = useWrapped(wrappedYear)
  const { data: customMatches = [] } = useQuery({
    queryKey: ['custom-matches'],
    queryFn: () => getCustomMatches().then(r => r.data),
    enabled: isAdmin && !offline,
    retry: false,
  })

  const handle = profile?.is_profile_public ? profile?.public_handle : ''
  const badges = achievements
    ? { earned: Number(achievements.earned ?? 0), total: Number(achievements.total ?? 20), to: '/achievements', tracks: achievements.tracks }
    : undefined

  const first = Number(tracker[0]?.value)
  const last = Number(tracker[tracker.length - 1]?.value)
  const change = tracker.length > 1 && Number.isFinite(first) && Number.isFinite(last) ? last - first : null
  const changeText = change == null
    ? '–'
    : `${change > 0 ? '+' : ''}${formatCompactPrice(change)}`

  const productsToReview = Number(dashboard?.products_needing_review_count ?? 0)
  const stats = {
    cards: dashboard?.total_cards ?? '–',
    sets: dashboard?.owned_sets ?? '–',
    pokedex: pokedexSummary ? `${pokedexSummary.owned}/${pokedexSummary.total}` : '–',
  }
  const showInstall = isIosDevice() && !isStandalone()
  const tileIcon = Icon => <Icon size={30} strokeWidth={2} aria-hidden="true" />

  return (
    <div className="space-y-5 pb-4">
      <h1 className="sr-only">{t('profile.title')}</h1>
      <LargeTitle>
        <TrainerCard
          user={{
            name: user?.username || t('profile.trainer'),
            handle,
            id: user?.id,
            sprite: user?.avatar_id ? `/api/pokedex/images/sprites/${user.avatar_id}.png` : undefined,
          }}
          stats={stats}
          badges={badges}
          level={todaySummary?.xp}
          showcase={showcase?.cards}
          className="mt-1"
        />
      </LargeTitle>

      <div className="mx-4 grid grid-cols-3 gap-3" data-testid="profile-tiles">
        <StatTile type="lightning" icon={BarChart3} label={t('nav.analytics')} value={changeText} detail={t('profile.thisMonth').replace('{amount}', '').trim()} to="/analytics" />
        <StatTile
          type="water"
          icon={Package}
          label={t('nav.products')}
          value={productsToReview > 0 ? productsToReview : tileIcon(Package)}
          detail={productsToReview > 0 ? t(productsToReview === 1 ? 'profile.productNeedsReview' : 'profile.productsNeedReview') : undefined}
          to="/products"
        />
        <StatTile type="grass" icon={ArrowLeftRight} label={t('nav.trades')} value={tileIcon(ArrowLeftRight)} to="/trades" />
        {multiUser && <StatTile type="psychic" icon={Trophy} label={t('nav.leaderboard')} value={tileIcon(Trophy)} to="/leaderboard" />}
        <StatTile type="fairy" icon={Award} label={t('profile.badges')} value={tileIcon(Award)} to="/achievements" />
        {multiUser && handle && <StatTile type="dragon" icon={Globe} label={t('profile.publicPage')} value={tileIcon(Users)} to={`/u/${handle}`} />}
      </div>

      <ListSection>
        <ListRow
          icon={Sparkles}
          iconColor="#FF9F0A"
          title={t('delights.showcaseRow')}
          value={fill(t('delights.showcaseCount'), { count: showcase?.cards?.length ?? 0, max: SHOWCASE_MAX })}
          onClick={() => setShowcaseOpen(true)}
          chevron
          testId="profile-showcase"
        />
        {wrapped && (
          <ListRow icon={PartyPopper} iconColor="#FF453A" title={fill(t('wrapped.row'), { year: wrapped.year })} to={`/wrapped/${wrapped.year}`} testId="profile-wrapped" />
        )}
        <ListRow icon={Dna} iconColor="#BF5AF2" title={t('delights.dna')} to="/dna" testId="profile-dna" />
      </ListSection>

      <ListSection>
        <ListRow icon={SettingsIcon} iconColor="#8E8E93" title={t('nav.settings')} to="/settings" testId="profile-settings" />
        {queue && (
          <ListRow
            icon={RefreshCw}
            iconColor="#0A84FF"
            title={t('profile.syncOffline')}
            value={items.length > 0 ? items.length : undefined}
            to="/offline"
          />
        )}
        {customMatches.length > 0 && (
          <ListRow icon={Package} iconColor="#FF9F0A" title={t('profile.migration')} value={customMatches.length} to="/migration" />
        )}
        {showInstall && (
          <ListRow icon={Download} iconColor="#30D158" title={t('profile.installTitle')} onClick={() => setInstallOpen(true)} chevron />
        )}
        {multiUser && (
          <button
            type="button"
            onClick={() => { logout() }}
            className="relative flex min-h-[44px] w-full items-center justify-center px-4 py-[11px] text-body text-red active:bg-elevated"
          >
            {t('auth.logout')}
          </button>
        )}
      </ListSection>

      <p className="px-4 text-center text-footnote text-text-muted">
        {t('profile.version').replace('{version}', __APP_VERSION__)}
      </p>

      {showcaseOpen && (
        <ShowcasePicker
          isOpen
          onClose={() => setShowcaseOpen(false)}
          saved={(showcase?.cards ?? []).map(card => card.id)}
        />
      )}

      <PageSheet
        isOpen={installOpen}
        onClose={() => setInstallOpen(false)}
        title={t('profile.installTitle')}
        leading={<span />}
        trailing={{ label: t('ios.done'), onPress: () => setInstallOpen(false) }}
      >
        <div className="space-y-3 p-4 text-body">
          <p className="font-semibold text-text-primary">{t('pwa.installTitle')}</p>
          <p className="text-text-secondary">{t('pwa.installSteps')}</p>
          {items.length > 0 && <p className="text-footnote text-yellow">{t('sync.syncBeforeInstall')}</p>}
        </div>
      </PageSheet>
    </div>
  )
}
