import { BrowserRouter, Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom'
import { Suspense, lazy, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import AppErrorBoundary from './components/AppErrorBoundary'
import PokeBallLoader from './components/PokeBallLoader'
import AuthStartupScreen from './components/AuthStartupScreen'
import { SettingsProvider } from './contexts/SettingsContext'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import AppBadgeSync from './components/pwa/AppBadgeSync'
import { forceChangePassword } from './api/client'
import Layout from './components/Layout'
import { useSettings } from './contexts/SettingsContext'
import PublicHomeButton from './components/PublicHomeButton'
import { ConfirmDialogProvider } from './contexts/ConfirmDialogContext'
import UpdateBanner from './components/pwa/UpdateBanner'
import { OfflineProvider, useRestoreGate } from './offline/OfflineProvider'
import { CardDbAutoSync } from './offline/carddb/useCardDb'
import LaunchSplash from './components/splash/LaunchSplash'

const HomeScreen = lazy(() => import('./pages/HomeScreen'))
const Profile = lazy(() => import('./pages/Profile'))
const CardSearch = lazy(() => import('./pages/CardSearch'))
const Collection = lazy(() => import('./pages/Collection'))
const Pokedex = lazy(() => import('./pages/Pokedex'))
const PokedexSpecies = lazy(() => import('./pages/PokedexSpecies'))
const Sets = lazy(() => import('./pages/Sets'))
const SetsLanguages = lazy(() => import('./pages/SetsLanguages'))
const LegacySeriesRedirect = lazy(() => import('./pages/SetsLanguages').then(module => ({ default: module.LegacySeriesRedirect })))
const SetDetail = lazy(() => import('./pages/SetDetail'))
const Wishlist = lazy(() => import('./pages/Wishlist'))
const Binders = lazy(() => import('./pages/Binders'))
const BinderDetail = lazy(() => import('./pages/BinderDetail'))
const DeckEditor = lazy(() => import('./pages/DeckEditor'))
const DeckCompare = lazy(() => import('./pages/DeckCompare'))
const Analytics = lazy(() => import('./pages/Analytics'))
const CollectionDna = lazy(() => import('./pages/CollectionDna'))
const WrappedStory = lazy(() => import('./wrapped/WrappedStory'))
const Products = lazy(() => import('./pages/Products'))
const Trades = lazy(() => import('./pages/Trades'))
const Settings = lazy(() => import('./pages/Settings'))
const CardMigration = lazy(() => import('./pages/CardMigration'))
const ScanQueue = lazy(() => import('./pages/ScanQueue'))
const OfflineCenter = lazy(() => import('./pages/OfflineCenter'))
const Login = lazy(() => import('./pages/Login'))
const InviteAccept = lazy(() => import('./pages/InviteAccept'))
const Leaderboard = lazy(() => import('./pages/Leaderboard'))
const Compare = lazy(() => import('./pages/Compare'))
const Achievements = lazy(() => import('./pages/Achievements'))
const UserCollection = lazy(() => import('./pages/UserCollection'))
const PublicProfile = lazy(() => import('./pages/PublicProfile'))
const PublicBinderView = lazy(() => import('./pages/PublicBinderView'))
const PublicWishlistView = lazy(() => import('./pages/PublicWishlistView'))
const PublicDeckView = lazy(() => import('./pages/PublicDeckView'))

function LegacyDeckBuildRedirect() {
  const { deckId } = useParams()
  return <Navigate to={`/decks/${deckId}`} replace />
}
const PublicDirectory = lazy(() => import('./pages/PublicDirectory'))
const CardSystemGallery = import.meta.env.DEV
  ? lazy(() => import('./components/card-system/CardSystemGallery'))
  : null
const IosGallery = import.meta.env.DEV
  ? lazy(() => import('./components/ios/IosGallery'))
  : null
const SplashPreview = import.meta.env.DEV
  ? lazy(() => import('./components/splash/SplashPreview'))
  : null

function RouteLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-primary">
      <PokeBallLoader size={48} />
    </div>
  )
}

function ForcePasswordChangeScreen() {
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const { user, updateCurrentUser } = useAuth()
  const { t } = useSettings()

  const forceChangeMutation = useMutation({
    mutationFn: forceChangePassword,
    onSuccess: () => {
      updateCurrentUser({ must_change_password: false })
      setNewPassword('')
      setConfirmPassword('')
    },
  })

  const passwordsMatch = newPassword === confirmPassword
  const canSubmit = newPassword && confirmPassword && passwordsMatch && !forceChangeMutation.isPending

  const handleSubmit = (event) => {
    event.preventDefault()
    if (!canSubmit) return
    forceChangeMutation.mutate(newPassword)
  }

  const fieldClass = 'w-full bg-transparent px-4 pb-2.5 pt-0.5 text-body text-text-primary outline-hidden'
  const labelClass = 'block px-4 pt-2.5 text-footnote text-text-secondary'

  return (
    <div className="min-h-screen bg-bg px-4 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(48px,env(safe-area-inset-top))]">
      <form onSubmit={handleSubmit} method="post" action="/change-password" className="mx-auto w-full max-w-md space-y-5">
        <header className="space-y-1">
          <h1 className="text-large-title text-text-primary">{t('settings.users.changePassword')}</h1>
          <p className="text-subheadline text-text-secondary">{t('settings.users.forcePasswordChange')}</p>
        </header>
        <input
          type="text"
          name="username"
          id="force-change-username"
          value={user?.username || ''}
          onChange={() => {}}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          tabIndex={-1}
          aria-label={t('auth.username')}
          className="sr-only"
        />
        <div className="overflow-hidden rounded-xl bg-card">
          <label htmlFor="force-change-new-password" className={labelClass}>{t('settings.users.newPassword')}</label>
          <input
            type="password"
            name="new-password"
            id="force-change-new-password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            className={fieldClass}
            minLength={10}
            required
          />
          <div className="mx-4 h-[0.5px] bg-border" aria-hidden="true" />
          <label htmlFor="force-change-confirm-password" className={labelClass}>{t('settings.users.confirmPassword')}</label>
          <input
            type="password"
            name="confirm-password"
            id="force-change-confirm-password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            className={fieldClass}
            required
          />
        </div>
        {!passwordsMatch && confirmPassword && (
          <p className="px-4 text-footnote text-red">{t('settings.users.passwordsDoNotMatch')}</p>
        )}
        {forceChangeMutation.isError && (
          <p className="px-4 text-footnote text-red">
            {forceChangeMutation.error?.response?.data?.detail || t('common.error')}
          </p>
        )}
        <button
          type="submit"
          disabled={!canSubmit}
          className="flex min-h-[50px] w-full items-center justify-center rounded-full bg-accent px-6 text-headline text-on-accent shadow-[0_4px_14px_color-mix(in_srgb,var(--color-accent)_28%,transparent)] disabled:opacity-40 ios-press"
        >
          {t('settings.users.changePassword')}
        </button>
      </form>
    </div>
  )
}

function lazyRoute(element) {
  return <Suspense fallback={<RouteLoader />}>{element}</Suspense>
}

function PublicRoutes() {
  return (
    <>
      <PublicHomeButton />
      <Outlet />
    </>
  )
}

function ProtectedRoutes() {
  const { user, loading, connectionError, multiUser, retryConnection } = useAuth()
  const restoring = useRestoreGate()

  // An offline start waits (on the black app background) for the first screen's saved data.
  if (restoring) return <div className="min-h-screen bg-bg" />

  if (loading) {
    return <AuthStartupScreen connectionError={connectionError} onRetry={retryConnection} />
  }

  if (!user && multiUser) {
    return <Navigate to="/login" replace />
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg-primary">
        <PokeBallLoader size={48} />
      </div>
    )
  }

  if (user.must_change_password) {
    return <ForcePasswordChangeScreen />
  }

  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={lazyRoute(<HomeScreen />)} />
        <Route path="dashboard" element={<Navigate to="/" replace />} />
        <Route path="profile" element={lazyRoute(<Profile />)} />
        <Route path="search" element={lazyRoute(<CardSearch />)} />
        <Route path="collection" element={lazyRoute(<Collection />)} />
        <Route path="pokedex" element={lazyRoute(<Pokedex />)} />
        <Route path="pokedex/:dexId" element={lazyRoute(<PokedexSpecies />)} />
        <Route path="collection/user/:userId" element={lazyRoute(<UserCollection />)} />
        <Route path="sets" element={lazyRoute(<SetsLanguages />)} />
        <Route path="sets/language/:lang" element={lazyRoute(<Sets />)} />
        <Route path="sets/language/:lang/series/:seriesKey" element={lazyRoute(<Sets />)} />
        <Route path="sets/series/:seriesKey" element={lazyRoute(<LegacySeriesRedirect />)} />
        <Route path="sets/:setId" element={lazyRoute(<SetDetail />)} />
        <Route path="wishlist" element={lazyRoute(<Wishlist />)} />
        <Route path="binders" element={lazyRoute(<Binders />)} />
        <Route path="binders/:binderId" element={lazyRoute(<BinderDetail />)} />
        <Route path="decks" element={<Navigate to="/binders" replace />} />
        <Route path="decks/inventory" element={<Navigate to="/binders" replace />} />
        <Route path="decks/compare" element={lazyRoute(<DeckCompare />)} />
        <Route path="decks/:deckId" element={lazyRoute(<DeckEditor />)} />
        <Route path="decks/:deckId/build" element={<LegacyDeckBuildRedirect />} />
        <Route path="analytics" element={lazyRoute(<Analytics />)} />
        <Route path="dna" element={lazyRoute(<CollectionDna />)} />
        <Route path="wrapped" element={lazyRoute(<WrappedStory />)} />
        <Route path="wrapped/:year" element={lazyRoute(<WrappedStory />)} />
        <Route path="products" element={lazyRoute(<Products />)} />
        <Route path="trades" element={lazyRoute(<Trades />)} />
        <Route path="leaderboard" element={lazyRoute(<Leaderboard />)} />
        <Route path="leaderboard/compare/:userId" element={lazyRoute(<Compare />)} />
        <Route path="achievements" element={lazyRoute(<Achievements />)} />
        <Route path="achievements/:userId" element={lazyRoute(<Achievements />)} />
        <Route path="settings" element={lazyRoute(<Settings />)} />
        <Route path="settings/:section" element={lazyRoute(<Settings />)} />
        <Route path="migration" element={lazyRoute(<CardMigration />)} />
        <Route path="scans" element={lazyRoute(<ScanQueue />)} />
        <Route path="scans/:jobId" element={lazyRoute(<ScanQueue />)} />
        <Route path="offline" element={lazyRoute(<OfflineCenter />)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export default function App() {
  return (
    <AppErrorBoundary>
    <AuthProvider>
      <SettingsProvider>
        <OfflineProvider>
        <ConfirmDialogProvider>
          <BrowserRouter>
            <Routes>
              {import.meta.env.DEV && <Route path="/__card-system" element={lazyRoute(<CardSystemGallery />)} />}
              {import.meta.env.DEV && <Route path="/__ios" element={lazyRoute(<IosGallery />)} />}
              {import.meta.env.DEV && <Route path="/__splash" element={lazyRoute(<SplashPreview />)} />}
              <Route path="/login" element={lazyRoute(<Login />)} />
              <Route path="/invite/:token" element={lazyRoute(<InviteAccept />)} />
              <Route path="/u" element={<PublicRoutes />}>
                <Route index element={lazyRoute(<PublicDirectory />)} />
                <Route path=":handle" element={lazyRoute(<PublicProfile />)} />
                <Route path=":handle/decks" element={lazyRoute(<PublicProfile />)} />
                <Route path=":handle/binder/:binderId" element={lazyRoute(<PublicBinderView />)} />
                <Route path=":handle/wishlist" element={lazyRoute(<PublicWishlistView />)} />
                <Route path=":handle/deck/:deckId" element={lazyRoute(<PublicDeckView />)} />
              </Route>
              <Route path="/*" element={<ProtectedRoutes />} />
            </Routes>
          </BrowserRouter>
          <UpdateBanner />
          {/* Fresh launches only; portaled above everything while the app renders underneath. */}
          <LaunchSplash />
          {/* Keeps the offline card database up to date in the background (Settings > Data & sync). */}
          <CardDbAutoSync />
          <AppBadgeSync />
        </ConfirmDialogProvider>
        </OfflineProvider>
      </SettingsProvider>
    </AuthProvider>
    </AppErrorBoundary>
  )
}
