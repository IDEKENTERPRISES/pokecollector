import { useState, useRef, useEffect } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Crown, RefreshCw, Download, Upload, Plus, Pencil, Trash2, User, UserCheck, UserX, Zap, Copy } from 'lucide-react'
import clsx from 'clsx'
import {
  getSyncStatus, triggerSync, triggerPriceSync, triggerAllPriceSync, rescheduleFullSync, reschedulePriceSync,
  downloadBackup, restoreBackup, exportCSV,
  getSetting, setSetting, getTelegramStatus, saveSettings, setAuthMode,
  getUsers, createUser, updateUser, deleteUser, changePassword, changeAvatar, changeUsername,
  getContributors, getSupporters, getCustomMatches, downloadDebugLog, logoutOtherDevices,
  getProfile, updateProfile, deleteScanDiagnostics,
  deleteAllCollectionCardPhotos,
} from '../api/client'
import api from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useTheme } from '../hooks/useTheme'
import { useSettings } from '../contexts/SettingsContext'
import { useConfirmDialog } from '../contexts/ConfirmDialogContext'
import Modal from '../components/ui/Modal'
import PasswordPromptDialog from '../components/ui/PasswordPromptDialog'
import AvatarPicker from '../components/AvatarPicker'
import ScannerSettingsCard from '../components/ScannerSettingsCard'
import NotificationsCard from '../components/pwa/NotificationsCard'
import { formatDistanceToNow } from 'date-fns'
import toast from 'react-hot-toast'
import { TCGDEX_LANGUAGES, normalizeTcgdexLanguageCsv, tcgdexLanguageLabel } from '../utils/tcgdexLanguages'
import { APP_LANGUAGES } from '../utils/appLanguages'
import { invalidateCollectionPhotoState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import ListRow from '../components/ios/ListRow'
import ListSection from '../components/ios/ListSection'
import PokeBall from '../components/ios/PokeBall'
import Switch from '../components/ios/Switch'
import { NAV_ICONS } from '../navigation/navIcons'
import { settingsSection, visibleSettingsSections } from '../navigation/navConfig'

// ─── Sub-components ───────────────────────────────────────────────────────────

// The sections whose controls still live in the former "General" block (docs/IOS_UI_DESIGN.md §5.6).
const GENERAL_SECTIONS = ['account', 'appearance', 'scanner', 'about', 'users']

/** /settings: the root list of sections with coloured icons. Hidden sections are left out, never disabled. */
function SettingsRoot({ t, isAdmin }) {
  return (
    <div className="space-y-4 py-4">
      <h1 className="px-1 text-2xl font-black tracking-tight text-text-primary">{t('settings.title')}</h1>
      <ListSection className="!mx-0">
        {visibleSettingsSections({ isAdmin }).map(item => (
          <ListRow
            key={item.key}
            to={`/settings/${item.key}`}
            icon={NAV_ICONS[item.icon]}
            iconColor={item.colour}
            title={t(item.titleKey)}
            testId={`settings-section-${item.key}`}
          />
        ))}
      </ListSection>
    </div>
  )
}

function SectionHeader({ title }) {
  return <h2 className="px-4 pb-1.5 text-footnote text-text-secondary">{title}</h2>
}

function SettingsCard({ children }) {
  return <div className="overflow-hidden rounded-xl bg-card">{children}</div>
}

/** An iOS row: label, Footnote description and the control on the right (`stacked`: below). */
function SettingsRow({ label, description, children, stacked = false }) {
  return (
    <div
      className={clsx(
        'border-t-[0.5px] border-border px-4 py-[11px] first:border-t-0',
        stacked ? 'space-y-2.5' : 'flex min-h-[44px] items-center justify-between gap-3',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="text-body text-text-primary">{label}</p>
        {description && (
          <p className="mt-0.5 text-footnote text-text-secondary" style={{ overflowWrap: 'anywhere' }}>{description}</p>
        )}
      </div>
      {children != null && (stacked ? <div className="w-full">{children}</div> : <div className="max-w-[55%] flex-shrink-0">{children}</div>)}
    </div>
  )
}

/** Pill button for a row's action. tone: 'tinted' | 'gray' | 'danger' | 'warning'. */
const ROW_BUTTON_TONES = {
  tinted: 'bg-accent/20 text-tint',
  gray: 'bg-fill-tertiary text-text-primary',
  danger: 'bg-red/15 text-red',
  warning: 'bg-yellow/15 text-yellow',
}
function rowButton(tone = 'gray') {
  return clsx(
    'inline-flex min-h-[32px] items-center gap-1.5 rounded-full px-3.5 text-subheadline font-semibold ios-press disabled:opacity-40',
    ROW_BUTTON_TONES[tone],
  )
}

function Toggle({ value, onChange, label, disabled = false }) {
  return <Switch checked={value} onChange={onChange} label={label} disabled={disabled} />
}

function SelectControl({ value, options, onChange }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="select max-w-full text-body"
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  )
}

/** The accent theme as a row of Poké Balls (design doc §7.3, §7.12). */
function ThemePicker({ theme, setTheme, themes, label }) {
  return (
    <div role="group" aria-label={label} className="grid grid-cols-3 gap-2 sm:grid-cols-5" data-testid="theme-picker">
      {themes.map((th) => {
        const active = theme === th.id
        return (
          <button
            key={th.id}
            type="button"
            onClick={() => setTheme(th.id)}
            aria-pressed={active}
            className={clsx(
              'flex flex-col items-center gap-1.5 rounded-xl py-2.5 ios-press',
              active ? 'bg-fill-tertiary ring-2' : 'bg-fill-quaternary',
            )}
            style={active ? { '--tw-ring-color': th.color } : undefined}
          >
            <PokeBall size={40} top={th.color} gloss />
            <span className="text-caption-1 text-text-secondary">{th.label}</span>
          </button>
        )
      })}
    </div>
  )
}

/** Change password and sign out other devices (Q13): every signed-in user in multi-user mode. */
function PasswordCard({ t }) {
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  return (
    <section className="space-y-1">
      <SectionHeader title={t('settings.users.changePassword')} />
      <SettingsCard>
        <div className="space-y-3 px-4 py-3">
          <input type="password" name="current-password" id="change-current-password" autoComplete="current-password" aria-label={t('settings.users.currentPassword')} placeholder={t('settings.users.currentPassword')} value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} className="input w-full" />
          <input type="password" name="new-password" id="change-new-password" autoComplete="new-password" aria-label={t('settings.users.newPassword')} placeholder={t('settings.users.newPassword')} value={newPw} onChange={(e) => setNewPw(e.target.value)} className="input w-full" />
          <button onClick={() => changePwMut.mutate({ current_password: currentPw, new_password: newPw })} disabled={!currentPw || !newPw || changePwMut.isPending} className="flex min-h-[44px] w-full items-center justify-center rounded-full bg-accent px-5 text-callout font-semibold text-on-accent ios-press disabled:opacity-40">
            {t('settings.users.changePassword')}
          </button>
        </div>
        <div className="border-t-[0.5px] border-border px-4 py-3">
          <p className="mb-2 text-footnote text-text-secondary">{t('settings.users.signOutOthersHint')}</p>
          <button onClick={() => logoutOthersMut.mutate()} disabled={logoutOthersMut.isPending} className={rowButton('gray')}>
            {t('settings.users.signOutOthers')}
          </button>
        </div>
      </SettingsCard>
    </section>
  )
}

function TcgdexLanguageControl({ value, onChange, selectedLabel, fallbackNote }) {
  const selected = new Set(normalizeTcgdexLanguageCsv(value).split(','))

  const toggle = (lang) => {
    const next = new Set(selected)
    if (next.has(lang)) {
      if (next.size === 1) return
      next.delete(lang)
    } else {
      next.add(lang)
    }
    const normalized = TCGDEX_LANGUAGES
      .map((language) => language.code)
      .filter((code) => next.has(code))
      .join(',')
    onChange(normalized || 'en,de')
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {TCGDEX_LANGUAGES.map((language) => (
          <button
            key={language.code}
            type="button"
            onClick={() => toggle(language.code)}
            className={`px-2 py-1.5 rounded-lg text-xs font-semibold text-left transition-colors border ${
              selected.has(language.code)
                ? 'bg-brand-red text-white border-brand-red'
                : 'bg-bg-card text-text-muted border-border hover:text-text-primary'
            }`}
            title={language.name}
          >
            {tcgdexLanguageLabel(language.code)}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-text-muted leading-relaxed">
        {selected.size} {selectedLabel}. {fallbackNote}
      </p>
    </div>
  )
}

function ContributorsSection({ t }) {
  const { data: contributors = [], isLoading } = useQuery({
    queryKey: ['contributors'],
    queryFn: () => getContributors(),
    staleTime: 60 * 60 * 1000,
  })

  if (isLoading) {
    return (
      <SettingsCard>
        <div className="p-4 flex justify-center">
          <div className="skeleton h-8 w-48 rounded" />
        </div>
      </SettingsCard>
    )
  }

  return (
    <SettingsCard>
      <div className="p-4">
        <div className="flex flex-wrap gap-4 justify-center">
          {contributors.map((c) => (
            <a key={c.login} href={c.html_url} target="_blank" rel="noreferrer" className="flex flex-col items-center gap-1.5 group">
              <img src={c.avatar_url} alt={c.login} className="w-12 h-12 rounded-full border-2 border-border group-hover:border-brand-red transition-colors" />
              <span className="text-[10px] font-semibold text-text-secondary group-hover:text-text-primary transition-colors">{c.login}</span>
              <span className="text-[9px] text-text-muted">
                {c.manual ? (c.note || t('settings.manualContributor')) : `${c.contributions} ${t('settings.commits')}`}
              </span>
            </a>
          ))}
        </div>
      </div>
    </SettingsCard>
  )
}

const SUPPORTER_CROWN_COLORS = {
  gold: '#facc15',
  silver: '#d1d5db',
  bronze: '#fb923c',
}

const CURRENCY_SYMBOLS = {
  EUR: '€',
  USD: '$',
  GBP: '£',
}

function formatSupporterAmount(amountCents, currency = 'EUR') {
  const cents = typeof amountCents === 'bigint' ? amountCents : BigInt(amountCents || 0)
  const safeCurrency = currency || 'EUR'
  const formattedAmount = `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
  const symbol = CURRENCY_SYMBOLS[safeCurrency]
  if (symbol) return `${symbol}${formattedAmount}`
  return `${formattedAmount} ${safeCurrency}`
}

export function summarizeSupporters(supporters = []) {
  const amountTotals = new Map()
  let donationCount = 0n
  let hasMixedCurrency = false

  for (const supporter of supporters) {
    if (!supporter.support) continue
    const support = supporter.support
    donationCount += BigInt(support.donation_count)
    if (support.currency === 'MIXED') {
      hasMixedCurrency = true
      continue
    }
    amountTotals.set(
      support.currency,
      (amountTotals.get(support.currency) || 0n) + BigInt(support.total_amount_cents),
    )
  }

  return {
    supporterCount: supporters.length,
    donationCount,
    amountTotals: [...amountTotals.entries()]
      .sort(([leftCurrency], [rightCurrency]) => leftCurrency.localeCompare(rightCurrency))
      .map(([currency, amountCents]) => ({ currency, amountCents })),
    hasMixedCurrency,
  }
}

function SupporterCard({ supporter, t }) {
  const support = supporter.support
  const content = (
    <div className="flex items-center gap-3 px-3 py-2 rounded-xl bg-bg-elevated border border-border text-left transition-colors hover:border-brand-red/50">
      {supporter.crown && (
        <Crown
          size={18}
          fill="currentColor"
          style={{ color: SUPPORTER_CROWN_COLORS[supporter.crown] || SUPPORTER_CROWN_COLORS.gold }}
          aria-label={supporter.crown}
          className="flex-shrink-0"
        />
      )}
      <div className="min-w-0">
        <p className="text-xs font-semibold text-text-primary truncate">{supporter.name}</p>
        {support && (
          <p className="text-[11px] text-text-secondary">
            {formatSupporterAmount(support.total_amount_cents, support.currency)} · {support.donation_count} {support.donation_count === 1 ? t('settings.supporterDonation') : t('settings.supporterDonations')}
          </p>
        )}
        {support?.latest_supported_on && (
          <p className="text-[10px] text-text-muted">{t('settings.latestSupport')}: {support.latest_supported_on}</p>
        )}
      </div>
    </div>
  )

  if (supporter.url) {
    return (
      <a href={supporter.url} target="_blank" rel="noreferrer" className="block min-w-[180px] flex-1 max-w-xs">
        {content}
      </a>
    )
  }

  return <div className="min-w-[180px] flex-1 max-w-xs">{content}</div>
}

export function SupportersPanel({ supporters = [], isLoading = false, unavailable = false, t }) {
  if (isLoading) {
    return (
      <SettingsCard>
        <div className="p-4 flex justify-center">
          <div className="skeleton h-8 w-48 rounded" />
        </div>
      </SettingsCard>
    )
  }

  if (unavailable) {
    return (
      <SettingsCard>
        <div className="p-4 text-center">
          <p className="text-sm text-text-muted">{t('settings.supportersUnavailable')}</p>
        </div>
      </SettingsCard>
    )
  }

  if (supporters.length === 0) {
    return (
      <SettingsCard>
        <div className="p-4 text-center">
          <p className="text-sm text-text-muted">{t('settings.noSupportersYet')}</p>
        </div>
      </SettingsCard>
    )
  }

  const summary = summarizeSupporters(supporters)
  const supporterLabel = summary.supporterCount === 1 ? t('settings.supporter') : t('settings.supporterPlural')
  const donationLabel = summary.donationCount === 1n ? t('settings.supporterDonation') : t('settings.supporterDonations')

  return (
    <SettingsCard>
      <div className="p-4">
        <div className="mb-4 pb-4 border-b border-border flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-text-secondary">
          <span><strong className="text-text-primary">{summary.supporterCount}</strong> {supporterLabel}</span>
          <span><strong className="text-text-primary">{summary.donationCount.toString()}</strong> {donationLabel}</span>
          {summary.amountTotals.length > 0 && (
            <span>
              <strong className="text-text-primary">
                {summary.amountTotals
                  .map(({ currency, amountCents }) => formatSupporterAmount(amountCents, currency))
                  .join(' + ')}
              </strong>{' '}{t('settings.totalSupport')}
            </span>
          )}
          {summary.hasMixedCurrency && <span>{t('settings.mixedCurrencySupport')}</span>}
        </div>
        <div className="flex flex-wrap gap-3 justify-center">
          {supporters.map((supporter, index) => (
            <SupporterCard key={`${supporter.name}-${supporter.url || index}`} supporter={supporter} t={t} />
          ))}
        </div>
      </div>
    </SettingsCard>
  )
}

export function supporterQueryOptions(queryFn = getSupporters) {
  return {
    queryKey: ['supporters'],
    queryFn,
    enabled: false,
    retry: false,
    staleTime: 0,
    gcTime: Infinity,
    refetchInterval: false,
    refetchIntervalInBackground: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    networkMode: 'always',
  }
}

function SupportersSection({ t }) {
  // Reuse one entry request across React StrictMode's effect replay, but not across real remounts.
  const entryRequestRef = useRef(null)
  const [entryPending, setEntryPending] = useState(true)
  const { data: supporters = [], refetch, isFetching, isError, isRefetchError } = useQuery(supporterQueryOptions())

  useEffect(() => {
    let active = true
    const entryRequest = entryRequestRef.current || refetch()
    entryRequestRef.current = entryRequest
    const finishEntry = () => {
      if (active) setEntryPending(false)
    }
    void entryRequest.then(finishEntry, finishEntry)
    return () => {
      active = false
    }
  }, [refetch])

  return <SupportersPanel supporters={supporters} isLoading={entryPending || isFetching} unavailable={isError || isRefetchError} t={t} />
}


// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Settings() {
  const fileInputRef = useRef(null)
  const [restoring, setRestoring] = useState(false)
  const [restorePromptFile, setRestorePromptFile] = useState(null)
  const [showAvatarPicker, setShowAvatarPicker] = useState(false)
  const [editingUsername, setEditingUsername] = useState(false)
  const [usernameInput, setUsernameInput] = useState('')
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { user, updateCurrentUser, multiUser, modeLocked } = useAuth()
  const { settings, updateSettings, t, pricePrimaryField, exchangeRate, currency: displayCurrency } = useSettings()
  const { data: currencyList } = useQuery({
    queryKey: ['currencies'],
    queryFn: () => api.get('/settings/currencies').then(r => r.data.currencies),
    staleTime: 24 * 60 * 60 * 1000,
  })
  const supportPageUrl = settings.language === 'de'
    ? 'https://pokecollector.romerg.de/de/#support'
    : 'https://pokecollector.romerg.de/#support'
  const confirmDialog = useConfirmDialog()
  const publicProfilesEnabled = settings.public_profiles_enabled === 'true'
  const { theme, setTheme, themes } = useTheme()
  const { section } = useParams()
  const isAdmin = user?.role === 'admin'
  const activeSection = visibleSettingsSections({ isAdmin }).some(item => item.key === section) ? section : null
  const showGeneral = GENERAL_SECTIONS.includes(activeSection)
  const setsInSeries = (settings.sets_view || 'series') !== 'sets'

  const [backupOptions, setBackupOptions] = useState(['full'])
  const [debugModeEnabled, setDebugModeEnabled] = useState(false)
  const [scanDiagnosticsSaving, setScanDiagnosticsSaving] = useState(false)
  const [scanDiagnosticsDeleting, setScanDiagnosticsDeleting] = useState(false)
  const [geminiFallbackSaving, setGeminiFallbackSaving] = useState(false)
  const [cardPhotosDeleting, setCardPhotosDeleting] = useState(false)

  // Recurring automatic full sync interval (days) and small price sync interval (minutes).
  const [fullSyncIntervalDays, setFullSyncIntervalDays] = useState('5')
  const [priceSyncIntervalMinutes, setPriceSyncIntervalMinutes] = useState('30')

  // Notification settings
  const [priceAlertsEnabled, setPriceAlertsEnabled] = useState(false)
  const [alertThreshold, setAlertThreshold] = useState('10')

  // Changing authentication mode has immediate access consequences, so always warn first.
  const [multiUserModalMode, setMultiUserModalMode] = useState(null)
  const [multiUserSaving, setMultiUserSaving] = useState(false)

  const applyMultiUserMode = async (val) => {
    try {
      await setAuthMode(val)
      window.location.reload()
      return true
    } catch {
      toast.error(t('common.error'))
      return false
    }
  }

  const confirmMultiUserChange = async () => {
    if (!multiUserModalMode) return
    setMultiUserSaving(true)
    const applied = await applyMultiUserMode(multiUserModalMode === 'enable')
    if (!applied) setMultiUserSaving(false)
  }

  // Load individual settings from backend
  const { data: fullSyncIntervalData } = useQuery({
    queryKey: ['setting', 'full_sync_interval_days'],
    queryFn: () => getSetting('full_sync_interval_days').catch(() => ({ value: '5' })),
  })

  const { data: priceSyncIntervalData } = useQuery({
    queryKey: ['setting', 'price_sync_interval_minutes'],
    queryFn: () => getSetting('price_sync_interval_minutes').catch(() => ({ value: '30' })),
  })

  const { data: priceAlertsData } = useQuery({
    queryKey: ['setting', 'price_alerts_enabled'],
    queryFn: () => getSetting('price_alerts_enabled').catch(() => ({ value: 'false' })),
  })

  const { data: alertThresholdData } = useQuery({
    queryKey: ['setting', 'price_alert_threshold'],
    queryFn: () => getSetting('price_alert_threshold').catch(() => ({ value: '10' })),
  })

  // Public profile
  const [profilePublic, setProfilePublic] = useState(false)
  const [publicShowValues, setPublicShowValues] = useState(false)
  const [wishlistVisibility, setWishlistVisibility] = useState('private')
  const [profileDirty, setProfileDirty] = useState(false)
  const [publicFeatureSaving, setPublicFeatureSaving] = useState(false)

  const { data: profileData } = useQuery({
    queryKey: ['profile'],
    queryFn: () => getProfile(),
  })

  useEffect(() => {
    if (profileData && !profileDirty) {
      setProfilePublic(!!profileData.is_profile_public)
      setPublicShowValues(!!profileData.public_show_values)
      setWishlistVisibility(profileData.wishlist_visibility || 'private')
    }
  }, [profileData, profileDirty])


  const [telegramBotToken, setTelegramBotToken] = useState('')
  const [telegramBotTokenDirty, setTelegramBotTokenDirty] = useState(false)
  const [telegramChatId, setTelegramChatId] = useState('')
  const [telegramChatIdDirty, setTelegramChatIdDirty] = useState(false)


  const { data: telegramBotTokenData } = useQuery({
    queryKey: ['setting', 'telegram_bot_token'],
    queryFn: () => getSetting('telegram_bot_token').catch(() => ({ value: '' })),
  })

  const { data: telegramChatIdData } = useQuery({
    queryKey: ['setting', 'telegram_chat_id'],
    queryFn: () => getSetting('telegram_chat_id').catch(() => ({ value: '' })),
  })

  const { data: telegramStatus } = useQuery({
    queryKey: ['telegram-status'],
    queryFn: () => getTelegramStatus().catch(() => ({ configured: false })),
  })

  const { data: syncStatus } = useQuery({
    queryKey: ['sync-status'],
    queryFn: () => getSyncStatus().then((r) => r.data),
    refetchInterval: 10000,
  })

  const { data: customMatches = [] } = useQuery({
    queryKey: ['custom-matches'],
    queryFn: () => getCustomMatches().then((r) => r.data),
    refetchInterval: 60000,
  })

  // Sync fetched data → local state
  useEffect(() => {
    if (fullSyncIntervalData?.value) setFullSyncIntervalDays(fullSyncIntervalData.value)
  }, [fullSyncIntervalData])

  useEffect(() => {
    if (priceSyncIntervalData?.value) setPriceSyncIntervalMinutes(priceSyncIntervalData.value)
  }, [priceSyncIntervalData])

  useEffect(() => {
    if (priceAlertsData?.value) setPriceAlertsEnabled(priceAlertsData.value === 'true')
  }, [priceAlertsData])

  useEffect(() => {
    if (alertThresholdData?.value) setAlertThreshold(alertThresholdData.value)
  }, [alertThresholdData])

  useEffect(() => {
    setDebugModeEnabled(settings.debug_mode === 'true')
  }, [settings.debug_mode])


  useEffect(() => {
    if (telegramBotTokenData?.value !== undefined && !telegramBotTokenDirty) setTelegramBotToken(telegramBotTokenData.value)
  }, [telegramBotTokenData])

  useEffect(() => {
    if (telegramChatIdData?.value !== undefined && !telegramChatIdDirty) setTelegramChatId(telegramChatIdData.value)
  }, [telegramChatIdData])

  // Sync mutation (full)
  const syncMutation = useMutation({
    mutationFn: triggerSync,
    onSuccess: () => {
      toast.success(t('settings.syncStarted'))
      setTimeout(() => queryClient.invalidateQueries(), 5000)
    },
    onError: () => toast.error(t('settings.syncFailed')),
  })

  // Forced price sync mutation (all tracked collection/wishlist/binder cards)
  // Admin price sync, the action Home's admin button ran (Q5): refreshes the tracked cards' prices.
  const priceSyncMutation = useMutation({
    mutationFn: triggerPriceSync,
    onSuccess: () => {
      toast.success(t('settings.syncStarted'))
      setTimeout(() => queryClient.invalidateQueries(), 5000)
    },
    onError: () => toast.error(t('settings.syncFailed')),
  })

  const allPriceSyncMutation = useMutation({
    mutationFn: triggerAllPriceSync,
    onSuccess: () => {
      toast.success(t('settings.syncStarted'))
      setTimeout(() => queryClient.invalidateQueries(), 5000)
    },
    onError: () => toast.error(t('settings.syncFailed')),
  })

  const avatarMutation = useMutation({
    mutationFn: (avatarId) => changeAvatar(avatarId),
    onSuccess: (updatedUser) => {
      updateCurrentUser(updatedUser)
      localStorage.setItem('lastUserAvatar', updatedUser.avatar_id || '')
      toast.success(t('auth.avatarChanged'))
    },
    onError: (err) => toast.error(err.response?.data?.detail || t('common.error')),
  })

  const profileMutation = useMutation({
    mutationFn: (data) => updateProfile(data),
    onSuccess: (data) => {
      queryClient.setQueryData(['profile'], data)
      queryClient.invalidateQueries({ queryKey: ['leaderboard'] })
      setProfilePublic(!!data.is_profile_public)
      setPublicShowValues(!!data.public_show_values)
      setWishlistVisibility(data.wishlist_visibility || 'private')
      setProfileDirty(false)
      toast.success(t('settings.saved'))
    },
    onError: (err) => toast.error(err.response?.data?.detail || t('settings.saveFailed')),
  })

  const savePublicProfile = () => {
    profileMutation.mutate({
      is_profile_public: profilePublic,
      public_show_values: publicShowValues,
      wishlist_visibility: wishlistVisibility,
    })
  }

  const publicHandle = profileData?.public_handle || ''
  const publicHandleError = profileData?.public_handle_error || ''
  const publicProfileUrl = publicHandle ? `${window.location.origin}/u/${publicHandle}` : ''
  const publicProfileSaveDisabled = profileMutation.isPending || (profilePublic && !publicHandle)

  const handlePublicProfilesToggle = async (enabled) => {
    setPublicFeatureSaving(true)
    try {
      await updateSettings({ public_profiles_enabled: enabled ? 'true' : 'false' })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['profile'] }),
        queryClient.invalidateQueries({ queryKey: ['binders'] }),
        queryClient.invalidateQueries({ queryKey: ['leaderboard'] }),
      ])
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveFailed'))
    } finally {
      setPublicFeatureSaving(false)
    }
  }

  const copyPublicProfileUrl = async () => {
    try {
      await navigator.clipboard.writeText(publicProfileUrl)
      toast.success(t('settings.linkCopied'))
    } catch {
      toast.error(t('settings.linkCopyFailed'))
    }
  }

  const isRunning = syncStatus?.is_running || syncStatus?.is_price_sync_running || syncMutation.isPending || priceSyncMutation.isPending || allPriceSyncMutation.isPending

  // Save helper
  const saveSetting = async (key, value) => {
    try {
      await setSetting(key, value)
      queryClient.invalidateQueries({ queryKey: ['setting', key] })
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveFailed'))
    }
  }

  const handlePriceSyncIntervalChange = async (val) => {
    setPriceSyncIntervalMinutes(val)
    await saveSetting('price_sync_interval_minutes', val)
    try { await reschedulePriceSync(parseInt(val)) } catch {}
  }

  const handleFullSyncIntervalChange = async (val) => {
    setFullSyncIntervalDays(val)
    await saveSetting('full_sync_interval_days', val)
    try { await rescheduleFullSync(parseInt(val)) } catch {}
  }

  const handlePriceAlertsToggle = async (val) => {
    setPriceAlertsEnabled(val)
    await saveSetting('price_alerts_enabled', val ? 'true' : 'false')
  }

  const handleAlertThresholdBlur = async () => {
    await saveSetting('price_alert_threshold', alertThreshold)
  }

  const handleSetsViewChange = async (inSeries) => {
    try {
      await updateSettings({ sets_view: inSeries ? 'series' : 'sets' })
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveFailed'))
    }
  }

  const handleLanguageChange = async (lang) => {
    try {
      await updateSettings({ language: lang })
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveFailed'))
    }
  }

  const handleCurrencyChange = async (val) => {
    try {
      await updateSettings({ currency: val })
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveFailed'))
    }
  }

  const handlePriceTypeChange = async (val) => {
    try {
      await updateSettings({ price_primary: val })
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveFailed'))
    }
  }

  const handleTcgdexSyncLanguagesChange = async (val) => {
    try {
      await updateSettings({ tcgdex_sync_languages: normalizeTcgdexLanguageCsv(val) })
      invalidateTcgdexFilterLanguages(queryClient)
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveFailed'))
    }
  }

  const handleDebugModeToggle = async (enabled) => {
    setDebugModeEnabled(enabled)
    try {
      await setSetting('debug_mode', enabled ? 'true' : 'false')
      queryClient.invalidateQueries({ queryKey: ['setting', 'debug_mode'] })
      toast.success(t('settings.saved'))
    } catch {
      setDebugModeEnabled(!enabled)
      toast.error(t('settings.saveFailed'))
    }
  }

  const handleScanDiagnosticsToggle = async (enabled) => {
    setScanDiagnosticsSaving(true)
    try {
      await updateSettings({ scan_diagnostics_enabled: enabled ? 'true' : 'false' })
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveFailed'))
    } finally {
      setScanDiagnosticsSaving(false)
    }
  }

  const handleGeminiFallbackToggle = async (enabled) => {
    setGeminiFallbackSaving(true)
    try {
      await updateSettings({ scanner_gemini_fallback: enabled ? 'true' : 'false' })
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveFailed'))
    } finally {
      setGeminiFallbackSaving(false)
    }
  }

  const handlePhotoPreferenceToggle = async (enabled) => {
    try {
      await updateSettings({ prefer_own_card_photos: enabled ? 'true' : 'false' })
      invalidateCollectionPhotoState(queryClient)
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveFailed'))
    }
  }

  const handleDeleteCardPhotos = async () => {
    const confirmed = await confirmDialog({
      title: t('common.delete'),
      message: t('settings.deleteCardPhotosConfirm'),
      confirmLabel: t('common.delete'),
      destructive: true,
    })
    if (!confirmed) return
    setCardPhotosDeleting(true)
    try {
      await deleteAllCollectionCardPhotos()
      invalidateCollectionPhotoState(queryClient)
      toast.success(t('settings.cardPhotosDeleted'))
    } catch {
      toast.error(t('settings.cardPhotosDeleteFailed'))
    } finally {
      setCardPhotosDeleting(false)
    }
  }

  const handleDeleteScanDiagnostics = async () => {
    const confirmed = await confirmDialog({
      title: t('common.delete'),
      message: t('settings.scanDiagnosticsDeleteConfirm'),
      confirmLabel: t('common.delete'),
      destructive: true,
    })
    if (!confirmed) return
    setScanDiagnosticsDeleting(true)
    try {
      await deleteScanDiagnostics()
      toast.success(t('settings.scanDiagnosticsDeleted'))
    } catch {
      toast.error(t('settings.scanDiagnosticsDeleteFailed'))
    } finally {
      setScanDiagnosticsDeleting(false)
    }
  }

  const handleAdminBooleanSettingToggle = async (key, enabled) => {
    try {
      await updateSettings({ [key]: enabled ? 'true' : 'false' })
      if (key === 'tcgdex_digital_sets_enabled') {
        queryClient.invalidateQueries()
      }
      toast.success(t('settings.saved'))
    } catch {
      toast.error(t('settings.saveFailed'))
    }
  }

  const handleDownloadDebugLog = async () => {
    try {
      await downloadDebugLog()
    } catch {
      toast.error(t('settings.debugLogDownloadFailed'))
    }
  }

  const handleRestoreUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.name.endsWith('.sql')) {
      toast.error(t('settings.selectSql'))
      return
    }
    const confirmed = await confirmDialog({
      title: t('common.restore'),
      message: t('settings.restoreConfirm'),
      confirmLabel: t('common.restore'),
      destructive: true,
    })
    e.target.value = ''
    if (!confirmed) return

    // With logins enabled the server also wants the administrator's password.
    if (multiUser) {
      setRestorePromptFile(file)
      return
    }
    await runRestore(file)
  }

  const runRestore = async (file, password) => {
    setRestoring(true)
    try {
      await restoreBackup(file, password)
      toast.success(t('settings.restoreSuccess'))
      setRestorePromptFile(null)
      queryClient.invalidateQueries()
    } catch (err) {
      toast.error(t('settings.errorPrefix') + (err.response?.data?.detail || err.message))
    } finally {
      setRestoring(false)
    }
  }

  const currentLang = settings.language || 'en'
  const currentAppLang = currentLang === 'zh' ? 'zh-cn' : currentLang
  const currentCurrency = settings.currency || 'EUR'
  const currentPriceType = settings.price_primary || 'trend'
  const currencyOptions = (() => {
    const base = currencyList?.length
      ? currencyList
      : [{ code: 'EUR', name: 'Euro', symbol: '€' }, { code: 'USD', name: 'US Dollar', symbol: '$' }]
    const options = base.map(c => ({ value: c.code, label: `${c.code} — ${c.name}` }))
    if (!options.some(o => o.value === currentCurrency)) options.push({ value: currentCurrency, label: currentCurrency })
    return options
  })()
  const exportParams = { price_field: pricePrimaryField, currency: displayCurrency, exchange_rate: exchangeRate }
  const currentTcgdexSyncLanguages = normalizeTcgdexLanguageCsv(settings.tcgdex_sync_languages || 'en,de')
  const digitalSetsEnabled = settings.tcgdex_digital_sets_enabled === 'true'
  const crossLanguagePriceFallback = settings.cross_language_price_fallback !== 'false'
  const crossLanguageImageFallback = settings.cross_language_image_fallback !== 'false'
  const scanDiagnosticsEnabled = settings.scan_diagnostics_enabled === 'true'
  const scanDiagnosticsAvailable = settings.scan_diagnostics_available === 'true'
  const scanDiagnosticsDeletionAvailable = settings.scan_diagnostics_deletion_available === 'true'
  const geminiFallbackEnabled = settings.scanner_gemini_fallback === 'true'
  const preferOwnCardPhotos = settings.prefer_own_card_photos === 'true'

  const usernameMutation = useMutation({
    mutationFn: (username) => changeUsername(username),
    onSuccess: (updatedUser) => {
      updateCurrentUser(updatedUser)
      queryClient.invalidateQueries({ queryKey: ['profile'] })
      queryClient.invalidateQueries({ queryKey: ['leaderboard'] })
      setEditingUsername(false)
      toast.success(t('common.saved'))
    },
    onError: (error) => toast.error(error.response?.data?.detail || t('common.error')),
  })

  const handleAvatarSelect = (avatarId) => {
    avatarMutation.mutate(avatarId)
  }

  const lastFullSyncText = syncStatus?.last_full_sync?.finished_at
    ? formatDistanceToNow(new Date(syncStatus.last_full_sync.finished_at), { addSuffix: true })
    : t('settings.neverSynced')
  const lastFullSyncDescription = syncStatus?.last_full_sync?.status === 'error'
    ? `${t('settings.lastSyncFailed')} ${lastFullSyncText}${syncStatus.last_full_sync.error_message ? `: ${syncStatus.last_full_sync.error_message}` : ''}`
    : lastFullSyncText

  // No section: the root list. An unknown or hidden section (and the old "general") goes back to it.
  if (!section) return <SettingsRoot t={t} isAdmin={isAdmin} />
  if (!activeSection) return <Navigate to="/settings" replace />

  return (
    <div className="space-y-6 py-4">
      <h1 className="sr-only">{t(settingsSection(activeSection).titleKey)}</h1>

      {showGeneral && (
        <>
          {/* ── 1. TRAINER ── */}
          {activeSection === 'account' && <section className="space-y-1">
            <SectionHeader title={t('settings.sectionTrainer')} />
            <SettingsCard>
              <SettingsRow
                label={t('auth.chooseAvatar')}
                description={user?.username || 'Trainer'}
              >
                <button
                  type="button"
                  onClick={() => setShowAvatarPicker(true)}
                  className="flex items-center gap-3 rounded-full bg-fill-tertiary py-1.5 pl-1.5 pr-4 ios-press"
                >
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-card">
                    {user?.avatar_id ? (
                      <img
                        src={`https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/${user.avatar_id}.gif`}
                        alt={`${user.username} avatar`}
                        className="h-12 w-12 pixelated"
                      />
                    ) : (
                      <User size={24} className="text-text-muted" />
                    )}
                  </div>
                  <span className="text-subheadline font-semibold text-tint">
                    {avatarMutation.isPending ? t('common.loading') : t('common.edit')}
                  </span>
                </button>
              </SettingsRow>
              <SettingsRow label={t('settings.username')} description={t('settings.usernameDesc')}>
                {editingUsername ? (
                  <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); usernameInput.trim() && usernameMutation.mutate(usernameInput.trim()) }}>
                    <input
                      type="text"
                      value={usernameInput}
                      onChange={(e) => setUsernameInput(e.target.value)}
                      className="input w-32"
                      style={{ WebkitTextFillColor: "var(--color-text-primary)", WebkitBoxShadow: "0 0 0px 1000px var(--color-bg) inset" }}
                      autoFocus
                      maxLength={32}
                    />
                    <button type="submit" disabled={usernameMutation.isPending} className={rowButton('tinted')}>
                      {usernameMutation.isPending ? '...' : '✓'}
                    </button>
                    <button type="button" onClick={() => setEditingUsername(false)} className={rowButton('gray')}>
                      ✕
                    </button>
                  </form>
                ) : (
                  <button
                    onClick={() => { setUsernameInput(user?.username || ''); setEditingUsername(true) }}
                    className={rowButton('gray')}
                  >
                    <Pencil size={12} />
                    {user?.username || 'Trainer'}
                  </button>
                )}
              </SettingsRow>

            </SettingsCard>
          </section>}

          {activeSection === 'account' && multiUser && <PasswordCard t={t} />}

          {/* ── PUBLIC PROFILE ── */}
          {activeSection === 'account' && (user?.role === 'admin' || publicProfilesEnabled) && <section className="space-y-1">
            <SectionHeader title={t('settings.sectionPublicProfile')} />
            <SettingsCard>
              {user?.role === 'admin' && (
                <SettingsRow
                  label={t('settings.publicProfilesGlobal')}
                  description={publicProfilesEnabled
                    ? t('settings.publicProfilesGlobalEnabledDesc')
                    : t('settings.publicProfilesGlobalDisabledDesc')}
                 
                >
                  <Toggle
                    value={publicProfilesEnabled}
                    onChange={handlePublicProfilesToggle}
                    label={t('settings.publicProfilesGlobal')}
                    disabled={publicFeatureSaving}
                  />
                </SettingsRow>
              )}
              {publicProfilesEnabled && <SettingsRow label={t('settings.publicTrainerName')} description={t('settings.publicTrainerNameDesc')}>
                <div className="flex w-full flex-col items-end gap-1">
                  <span className="w-full truncate text-right text-body text-text-secondary">
                    {profileData?.trainer_name || user?.username || t('settings.username')}
                  </span>
                  {publicProfileUrl && (
                    <span className="w-full truncate text-right font-mono text-caption-2 text-text-secondary">
                      {publicProfileUrl}
                    </span>
                  )}
                  {publicHandleError && (
                    <span className="w-full text-right text-footnote font-semibold text-red">
                      {publicHandleError}
                    </span>
                  )}
                </div>
              </SettingsRow>}
              {publicProfilesEnabled && <SettingsRow label={t('settings.publicProfileToggle')} description={t('settings.publicProfileToggleDesc')}>
                <Toggle
                  value={profilePublic}
                  onChange={(val) => { setProfilePublic(val); setProfileDirty(true) }}
                  label={t('settings.publicProfileToggle')}
                />
              </SettingsRow>}
              {publicProfilesEnabled && <SettingsRow label={t('settings.wishlistVisibility')} description={t('settings.wishlistVisibilityDesc')}>
                <SelectControl
                  value={wishlistVisibility}
                  options={[
                    { value: 'private', label: t('settings.wishlistVisibilityPrivate') },
                    { value: 'trade_matches', label: t('settings.wishlistVisibilityMatches') },
                    { value: 'public', label: t('settings.wishlistVisibilityPublic') },
                  ]}
                  onChange={(value) => { setWishlistVisibility(value); setProfileDirty(true) }}
                />
              </SettingsRow>}
              {publicProfilesEnabled && <SettingsRow label={t('settings.publicShowValues')} description={t('settings.publicShowValuesDesc')}>
                <Toggle
                  value={publicShowValues}
                  onChange={(val) => { setPublicShowValues(val); setProfileDirty(true) }}
                  label={t('settings.publicShowValues')}
                />
              </SettingsRow>}
              {publicProfilesEnabled && profilePublic && publicHandle && (
                <SettingsRow label={t('settings.publicProfileLink')} description={publicProfileUrl}>
                  <button
                    type="button"
                    onClick={copyPublicProfileUrl}
                    className={rowButton('gray')}
                  >
                    <Copy size={13} /> {t('common.copy')}
                  </button>
                </SettingsRow>
              )}
            </SettingsCard>
            {publicProfilesEnabled && <div className="flex justify-end px-1 pt-2">
              <button
                onClick={savePublicProfile}
                disabled={publicProfileSaveDisabled}
                className="flex min-h-[44px] items-center justify-center rounded-full bg-accent px-6 text-callout font-semibold text-on-accent ios-press disabled:opacity-40"
              >
                {profileMutation.isPending ? t('common.saving') : t('common.save')}
              </button>
            </div>}
          </section>}

          {/* ── 2. THEME ── */}
          {activeSection === 'appearance' && <section className="space-y-1">
            <SectionHeader title={t('settings.sectionTheme')} />
            <SettingsCard>
              <SettingsRow label={t('settings.theme')} stacked>
                <ThemePicker theme={theme} setTheme={setTheme} themes={themes} label={t('settings.theme')} />
              </SettingsRow>
            </SettingsCard>
          </section>}

          {activeSection === 'users' && user?.role === 'admin' && (
            <section className="space-y-1">
              <SectionHeader title={t('settings.sectionMultiUser')} />
              <SettingsCard>
                <SettingsRow
                  label={t('settings.multiUserMode')}
                  description={modeLocked ? t('settings.multiUserModeLocked') : t('settings.multiUserModeDesc')}
                >
                  <Toggle
                    value={multiUser}
                    disabled={modeLocked}
                    label={t('settings.multiUserMode')}
                    onChange={(val) => {
                      if (modeLocked) return
                      setMultiUserModalMode(val ? 'enable' : 'disable')
                    }}
                  />
                </SettingsRow>
              </SettingsCard>

              <Modal
                isOpen={Boolean(multiUserModalMode)}
                onClose={() => {
                  if (!multiUserSaving) setMultiUserModalMode(null)
                }}
                title={t(multiUserModalMode === 'disable'
                  ? 'settings.multiUserDisableTitle'
                  : 'settings.multiUserEnableTitle')}
                size="sm"
                mobileSheet={false}
              >
                <div className="space-y-4 p-4">
                  <p className="text-sm text-text-primary">
                    {multiUserModalMode === 'disable'
                      ? t('settings.multiUserDisableWarning')
                      : t('settings.multiUserEnableWarning').replace('{username}', user?.username ?? 'admin')}
                  </p>
                  <p className="text-xs text-text-muted">
                    {t(multiUserModalMode === 'disable'
                      ? 'settings.multiUserDisablePreserved'
                      : 'settings.multiUserEnableResetHint')}
                  </p>
                  <div className="flex gap-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setMultiUserModalMode(null)}
                      disabled={multiUserSaving}
                      className="btn-ghost flex-1"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={confirmMultiUserChange}
                      disabled={multiUserSaving}
                      className="btn-primary flex-1 whitespace-normal"
                    >
                      {multiUserSaving
                        ? t('common.saving')
                        : t(multiUserModalMode === 'disable'
                          ? 'settings.multiUserDisableConfirm'
                          : 'settings.multiUserEnableConfirm')}
                    </button>
                  </div>
                </div>
              </Modal>
            </section>
          )}

          {/* ── 3. DARSTELLUNG ── */}
          {activeSection === 'appearance' && <section className="space-y-1">
            <SectionHeader title={t('settings.sectionAppearance')} />
            <SettingsCard>
              <SettingsRow label={t('settings.showSetsInSeries')} description={t('settings.showSetsInSeriesDesc')}>
                <Toggle
                  value={setsInSeries}
                  label={t('settings.showSetsInSeries')}
                  onChange={handleSetsViewChange}
                />
              </SettingsRow>
              <SettingsRow label={t('settings.language')} description={t('settings.languageDesc')}>
                <SelectControl
                  value={currentAppLang}
                  options={APP_LANGUAGES}
                  onChange={handleLanguageChange}
                />
              </SettingsRow>
              <SettingsRow label={t('settings.currency')} description={t('settings.currencyDesc')}>
                <SelectControl
                  value={currentCurrency}
                  options={currencyOptions}
                  onChange={handleCurrencyChange}
                />
              </SettingsRow>
              <SettingsRow label={t('settings.priceType')} description={t('settings.priceTypeDesc')}>
                <SelectControl
                  value={currentPriceType}
                  options={[
                    { value: 'trend', label: t('settings.priceTrend') },
                    { value: 'avg', label: t('settings.priceAvg') },
                    { value: 'avg1', label: t('settings.priceAvg1') },
                    { value: 'avg7', label: t('settings.priceAvg7') },
                    { value: 'avg30', label: t('settings.priceAvg30') },
                    { value: 'low', label: t('settings.priceLow') },
                  ]}
                  onChange={handlePriceTypeChange}
                />
              </SettingsRow>
              <SettingsRow
                label={t('settings.preferOwnCardPhotos')}
                description={t('settings.preferOwnCardPhotosDesc')}
              >
                <Toggle
                  value={preferOwnCardPhotos}
                  label={t('settings.preferOwnCardPhotos')}
                  onChange={handlePhotoPreferenceToggle}
                />
              </SettingsRow>
              <SettingsRow
                label={t('settings.deleteCardPhotos')}
                description={t('settings.deleteCardPhotosDesc')}
              >
                <button
                  type="button"
                  onClick={handleDeleteCardPhotos}
                  disabled={cardPhotosDeleting}
                  className={rowButton('danger')}
                >
                  <Trash2 size={13} />
                  {cardPhotosDeleting ? t('common.deleting') : t('common.delete')}
                </button>
              </SettingsRow>
            </SettingsCard>
          </section>}

          {/* ── 6. KI / KARTEN-SCANNER ── */}
          {activeSection === 'scanner' && <section className="space-y-1">
            <SectionHeader title={t('settings.sectionAI')} />
            <ScannerSettingsCard t={t} />
            <SettingsCard>
              <SettingsRow
                label={t('settings.geminiFallback')}
                description={t('settings.geminiFallbackDesc')}
              >
                <Toggle
                  value={geminiFallbackEnabled}
                  label={t('settings.geminiFallback')}
                  onChange={handleGeminiFallbackToggle}
                  disabled={geminiFallbackSaving}
                />
              </SettingsRow>
              <SettingsRow
                label={t('settings.scanDiagnostics')}
                description={scanDiagnosticsAvailable
                  ? t('settings.scanDiagnosticsDesc')
                  : t('settings.scanDiagnosticsUnavailable')}
              >
                <div className="flex items-center gap-2">
                  <Toggle
                    value={scanDiagnosticsEnabled}
                    label={t('settings.scanDiagnostics')}
                    onChange={handleScanDiagnosticsToggle}
                    disabled={!scanDiagnosticsAvailable || scanDiagnosticsSaving}
                  />
                  <button
                    type="button"
                    onClick={handleDeleteScanDiagnostics}
                    disabled={!scanDiagnosticsDeletionAvailable || scanDiagnosticsDeleting}
                    className={rowButton('danger')}
                  >
                    <Trash2 size={13} />
                    {scanDiagnosticsDeleting
                      ? t('settings.scanDiagnosticsDeleting')
                      : t('settings.scanDiagnosticsDelete')}
                  </button>
                </div>
              </SettingsRow>
            </SettingsCard>
          </section>}

          {/* ── 7. EBAY API ── */}
          

          {/* ── 8. ÜBER DIE APP ── */}
          {activeSection === 'about' && <section className="space-y-1">
            <SectionHeader title={t('settings.sectionAbout')} />
            <SettingsCard>
              <SettingsRow label={t('settings.app')} description="Pokemon TCG Collection">
                <span className="text-body text-text-secondary tabular-nums">
                  v{__APP_VERSION__}
                </span>
              </SettingsRow>
              <SettingsRow label={t('settings.dataSource')} description={t('settings.dataSourceDesc')}>
                <a
                  href="https://tcgdex.dev"
                  target="_blank"
                  rel="noreferrer"
                  className="text-body text-tint"
                >
                  TCGdex ↗
                </a>
              </SettingsRow>
              <SettingsRow label={t('settings.sourceCode')} description={t('settings.sourceCodeDesc')}>
                <a
                  href="https://github.com/Git-Romer/pokecollector"
                  target="_blank"
                  rel="noreferrer"
                  className="text-body text-tint"
                >
                  GitHub ↗
                </a>
              </SettingsRow>
              <SettingsRow label={t('settings.creatorWebsite')} description={t('settings.creatorWebsiteDesc')}>
                <a
                  href="https://romerg.de/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-body text-tint"
                >
                  romerg.de ↗
                </a>
              </SettingsRow>
              <SettingsRow label={t('settings.contact')} description={t('settings.contactDesc')}>
                <a
                  href="mailto:info@romerg.de"
                  className="text-body text-tint"
                >
                  info@romerg.de
                </a>
              </SettingsRow>
            </SettingsCard>
            <div className="text-center mt-4 mb-2">
              <p className="text-[11px] text-text-muted">
                {t('settings.madeWith')} <a href="https://romerg.de/" target="_blank" rel="noreferrer" className="text-brand-red hover:opacity-80 transition-opacity font-semibold">Gilles Romer</a>
              </p>
            </div>
          </section>}
        </>
      )}

      {activeSection === 'data' && (
        <>
          {/* ── 3. SYNCHRONISATION ── */}
          <section className="space-y-1">
            <SectionHeader title={t('settings.sectionSync')} />

            {/* Card 1: Full Sync */}
            <SettingsCard>
              <SettingsRow label={t('settings.syncSetsCards')} description={lastFullSyncDescription}>
                <button
                  onClick={() => syncMutation.mutate()}
                  disabled={isRunning}
                  className={rowButton('tinted')}
                >
                  <RefreshCw size={13} className={isRunning ? 'animate-spin' : ''} />
                  {isRunning ? t('settings.running') : t('settings.syncButton')}
                </button>
              </SettingsRow>
              {user?.role === 'admin' && (
                <SettingsRow label={t('settings.tcgdexSyncLanguages')} description={t('settings.tcgdexSyncLanguagesDesc')} stacked>
                  <TcgdexLanguageControl
                    value={currentTcgdexSyncLanguages}
                    onChange={handleTcgdexSyncLanguagesChange}
                    selectedLabel={t('settings.tcgdexSyncLanguagesSelected')}
                    fallbackNote={t('settings.tcgdexSyncLanguagesFallbackNote')}
                  />
                </SettingsRow>
              )}
              {user?.role === 'admin' && (
                <>
                  <SettingsRow label={t('settings.digitalSets')} description={t('settings.digitalSetsDesc')}>
                    <Toggle
                      value={digitalSetsEnabled}
                      label={t('settings.digitalSets')}
                      onChange={(val) => handleAdminBooleanSettingToggle('tcgdex_digital_sets_enabled', val)}
                    />
                  </SettingsRow>
                  <SettingsRow label={t('settings.crossLanguagePriceFallback')} description={t('settings.crossLanguagePriceFallbackDesc')}>
                    <Toggle
                      value={crossLanguagePriceFallback}
                      label={t('settings.crossLanguagePriceFallback')}
                      onChange={(val) => handleAdminBooleanSettingToggle('cross_language_price_fallback', val)}
                    />
                  </SettingsRow>
                  <SettingsRow label={t('settings.crossLanguageImageFallback')} description={t('settings.crossLanguageImageFallbackDesc')}>
                    <Toggle
                      value={crossLanguageImageFallback}
                      label={t('settings.crossLanguageImageFallback')}
                      onChange={(val) => handleAdminBooleanSettingToggle('cross_language_image_fallback', val)}
                    />
                  </SettingsRow>
                </>
              )}
              {customMatches.length > 0 && (
                <SettingsRow label={t('migration.title')} description={`${customMatches.length} ${t('migration.pendingMatches')}`}>
                  <button
                    onClick={() => navigate('/migration')}
                    className={rowButton('warning')}
                  >
                    <Zap size={13} />
                    {t('migration.title')}
                  </button>
                </SettingsRow>
              )}
              {user?.role === 'admin' && (
                <SettingsRow label={t('settings.interval')} description={t('settings.syncSetsCardsDesc')}>
                  <SelectControl
                    value={fullSyncIntervalDays}
                    options={[
                      { value: '1',  label: t('settings.day1') },
                      { value: '2',  label: t('settings.days2') },
                      { value: '3',  label: t('settings.days3') },
                      { value: '5',  label: t('settings.days5') },
                      { value: '7',  label: t('settings.days7') },
                      { value: '14', label: t('settings.days14') },
                      { value: '30', label: t('settings.days30') },
                    ]}
                    onChange={handleFullSyncIntervalChange}
                  />
                </SettingsRow>
              )}
            </SettingsCard>

            {/* Card 2: Price Sync */}
            <SettingsCard>
              {user?.role === 'admin' && (
                <SettingsRow label={t('settings.updatePrices')} description={t('settings.updatePricesDesc')}>
                  <button
                    onClick={() => priceSyncMutation.mutate()}
                    disabled={isRunning}
                    className={rowButton('tinted')}
                  >
                    <RefreshCw size={13} className={isRunning ? 'animate-spin' : ''} />
                    {isRunning ? t('settings.running') : t('settings.syncButton')}
                  </button>
                </SettingsRow>
              )}
              <SettingsRow label={t('settings.syncPricesOnly')} description={t('settings.syncPricesOnlyDesc')}>
                <button
                  onClick={() => allPriceSyncMutation.mutate()}
                  disabled={isRunning}
                  className={rowButton('tinted')}
                >
                  <RefreshCw size={13} className={isRunning ? 'animate-spin' : ''} />
                  {isRunning ? t('settings.running') : t('settings.syncButton')}
                </button>
              </SettingsRow>
              {user?.role === 'admin' && (
                <SettingsRow label={t('settings.priceInterval')} description={t('settings.autoSmallSyncDesc')}>
                  <SelectControl
                    value={priceSyncIntervalMinutes}
                    options={[
                      { value: '60',   label: t('settings.min60') },
                      { value: '120',  label: t('settings.min120') },
                      { value: '180',  label: t('settings.min180') },
                      { value: '360',  label: t('settings.min360') },
                      { value: '720',  label: t('settings.min720') },
                      { value: '1440', label: t('settings.min1440') },
                    ]}
                    onChange={handlePriceSyncIntervalChange}
                  />
                </SettingsRow>
              )}
            </SettingsCard>
          </section>

          {/* ── 5. DATEN ── */}
          <section className="space-y-1">
            <SectionHeader title={t('settings.sectionData')} />
            <SettingsCard>
              {user?.role === 'admin' && (
                <SettingsRow label={t('settings.debugMode')} description={t('settings.debugModeDesc')}>
                  <div className="flex items-center gap-2 justify-end">
                    <button
                      onClick={handleDownloadDebugLog}
                      className={rowButton('gray')}
                    >
                      <Download size={13} /> {t('settings.debugLogDownload')}
                    </button>
                    <Toggle value={debugModeEnabled} onChange={handleDebugModeToggle} label={t('settings.debugMode')} />
                  </div>
                </SettingsRow>
              )}
              <SettingsRow label={t('settings.clearImageCache')} description={t('settings.clearImageCacheDesc')}>
                <button
                  onClick={async () => {
                    const confirmed = await confirmDialog({
                      title: t('settings.clearImageCache'),
                      message: t('settings.clearImageCacheConfirm'),
                      confirmLabel: t('common.clear'),
                      destructive: true,
                    })
                    if (!confirmed) return
                    try {
                      await api.post('/backup/clear-image-cache')
                      toast.success(t('settings.clearImageCacheSuccess'))
                    } catch {
                      toast.error(t('settings.clearImageCacheFailed'))
                    }
                  }}
                  className={rowButton('danger')}
                >
                  🗑️ {t('settings.clearImageCache')}
                </button>
              </SettingsRow>
              <SettingsRow label={t('settings.csvExport')} description={t('settings.csvExportDesc')}>
                <button
                  onClick={() => exportCSV(exportParams)}
                  className={rowButton('gray')}
                >
                  <Download size={13} /> {t('settings.exportButton')}
                </button>
              </SettingsRow>
              <SettingsRow label={t('settings.backupDownload')} description={t('settings.backupDownloadDesc')} stacked>
                <div className="flex flex-col gap-3 items-start">
                  <div className="flex flex-wrap gap-1.5">
                    {[
                      { key: 'full', label: t('settings.backupFull') },
                      { key: 'collection', label: t('settings.backupCollection') },
                      { key: 'users', label: t('settings.backupUsers') },
                      { key: 'cards', label: t('settings.backupCards') },
                      { key: 'products', label: t('settings.backupProducts') },
                      { key: 'images', label: t('settings.backupImages') },
                    ].map(opt => {
                      const active = backupOptions.includes(opt.key)
                      return (
                        <button
                          key={opt.key}
                          onClick={() => {
                            if (opt.key === 'full') {
                              setBackupOptions(active ? [] : ['full'])
                            } else {
                              setBackupOptions(prev => {
                                const next = prev.filter(k => k !== 'full')
                                return active ? next.filter(k => k !== opt.key) : [...next, opt.key]
                              })
                            }
                          }}
                          aria-pressed={active}
                          className={clsx(
                            'min-h-[32px] rounded-full px-3 text-footnote font-semibold ios-press',
                            active ? 'bg-accent text-on-accent' : 'bg-fill-tertiary text-text-secondary',
                          )}
                        >
                          {opt.label}
                        </button>
                      )
                    })}
                  </div>
                  <button
                    onClick={() => downloadBackup(backupOptions.join(',') || 'full')}
                    disabled={backupOptions.length === 0}
                    className={rowButton('gray')}
                  >
                    <Download size={13} /> {t('settings.backupButton')}
                  </button>
                </div>
              </SettingsRow>
              <SettingsRow label={t('settings.backupImport')} description={t('settings.backupImportDesc')}>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={restoring}
                  className={rowButton('gray')}
                >
                  <Upload size={13} /> {restoring ? t('settings.importing') : t('settings.importButton')}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".sql"
                  className="hidden"
                  onChange={handleRestoreUpload}
                />
              </SettingsRow>
            </SettingsCard>
            <PasswordPromptDialog
              isOpen={Boolean(restorePromptFile)}
              onClose={() => setRestorePromptFile(null)}
              onSubmit={(password) => runRestore(restorePromptFile, password)}
              title={t('settings.restorePasswordTitle')}
              message={t('settings.restorePasswordMessage')}
              label={t('settings.users.password')}
              submitLabel={t('common.restore')}
              cancelLabel={t('common.cancel')}
              isPending={restoring}
            />
          </section>
        </>
      )}

      {activeSection === 'notifications' && (
        <>
          {/* ── 4. BENACHRICHTIGUNGEN ── */}
          <section className="space-y-1">
            <SectionHeader title={t('settings.sectionNotifications')} />
            <SettingsCard>
              <SettingsRow
                label={t('settings.telegramBot')}
                description={t('settings.telegramBotDesc')}
              >
                {telegramStatus?.configured ? (
                  <span
                    className="rounded-full bg-green/15 px-2.5 py-1 text-footnote font-semibold text-green"
                  >
                    {t('settings.telegramConfigured')}
                  </span>
                ) : (
                  <span
                    className="rounded-full bg-red/15 px-2.5 py-1 text-footnote font-semibold text-red"
                  >
                    {t('settings.telegramNotConfigured')}
                  </span>
                )}
              </SettingsRow>
              <SettingsRow label={t('settings.telegramBotToken')} description={t('settings.telegramBotTokenDesc')} stacked>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={telegramBotToken}
                    onChange={e => { setTelegramBotToken(e.target.value); setTelegramBotTokenDirty(true) }}
                    placeholder="1234567890:AAF..."
                    className="input text-xs font-mono"
                    style={{ minWidth: 0, flex: 1 }}
                  />
                  {telegramBotToken && !telegramBotTokenDirty && (
                    <span className="text-xs text-green flex-shrink-0">✅</span>
                  )}
                  {telegramBotTokenDirty && (
                    <button
                      onClick={async () => {
                        await saveSetting('telegram_bot_token', telegramBotToken)
                        setTelegramBotTokenDirty(false)
                        queryClient.invalidateQueries({ queryKey: ['setting', 'telegram_bot_token'] })
                        queryClient.invalidateQueries({ queryKey: ['telegram-status'] })
                        toast.success(t('settings.apiKeySaved'))
                      }}
                      className={clsx(rowButton('tinted'), 'flex-shrink-0')}
                    >
                      {t('common.save')}
                    </button>
                  )}
                </div>
              </SettingsRow>
              <SettingsRow label={t('settings.telegramChatId')} description={t('settings.telegramChatIdDesc')} stacked>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={telegramChatId}
                    onChange={e => { setTelegramChatId(e.target.value); setTelegramChatIdDirty(true) }}
                    placeholder="-100123456789"
                    className="input text-xs font-mono"
                    style={{ minWidth: 0, flex: 1 }}
                  />
                  {telegramChatId && !telegramChatIdDirty && (
                    <span className="text-xs text-green flex-shrink-0">✅</span>
                  )}
                  {telegramChatIdDirty && (
                    <button
                      onClick={async () => {
                        await saveSetting('telegram_chat_id', telegramChatId)
                        setTelegramChatIdDirty(false)
                        queryClient.invalidateQueries({ queryKey: ['setting', 'telegram_chat_id'] })
                        queryClient.invalidateQueries({ queryKey: ['telegram-status'] })
                        toast.success(t('settings.apiKeySaved'))
                      }}
                      className={clsx(rowButton('tinted'), 'flex-shrink-0')}
                    >
                      {t('common.save')}
                    </button>
                  )}
                </div>
              </SettingsRow>
              <SettingsRow
                label={t('settings.priceAlerts')}
                description={t('settings.priceAlertsDesc')}
              >
                <Toggle value={priceAlertsEnabled} onChange={handlePriceAlertsToggle} label={t('settings.priceAlerts')} />
              </SettingsRow>
              {priceAlertsEnabled && (
                <SettingsRow
                  label={t('settings.threshold')}
                  description={t('settings.thresholdDesc')}
                >
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      value={alertThreshold}
                      onChange={(e) => setAlertThreshold(e.target.value)}
                      onBlur={handleAlertThresholdBlur}
                      min="1"
                      max="100"
                      className="input w-20 text-right"
                    />
                    <span className="text-xs text-text-muted">%</span>
                  </div>
                </SettingsRow>
              )}
                          </SettingsCard>
          </section>

          <NotificationsCard />
        </>
      )}

      {activeSection === 'community' && (
        <>
          <section className="space-y-1">
            <SectionHeader title={t('settings.contributors')} />
            <ContributorsSection t={t} />
          </section>

          <section className="space-y-1 mt-4">
            <SectionHeader title={t('settings.supporters')} />
            <SupportersSection t={t} />
          </section>

          <section className="space-y-1 mt-4">
            <SectionHeader title={t('settings.sponsors')} />
            <SettingsCard>
              <div className="p-4 text-center space-y-3">
                <p className="text-2xl">🐾</p>
                <p className="text-sm font-semibold text-text-secondary">PokéCollector × Tierrettung Köln-Porz</p>
                <a
                  href={supportPageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-brand-red text-white text-sm font-semibold hover:opacity-90 transition-opacity"
                >
                  🐾 Betterplace
                </a>
              </div>
            </SettingsCard>
          </section>
        </>
      )}

      {activeSection === 'users' && user?.role === 'admin' && multiUser && (
        <UsersTab t={t} queryClient={queryClient} />
      )}

      <AvatarPicker
        isOpen={showAvatarPicker}
        onClose={() => setShowAvatarPicker(false)}
        onSelect={handleAvatarSelect}
        currentAvatarId={user?.avatar_id ?? null}
      />
    </div>
  )
}

function UsersTab({ t, queryClient }) {
  const confirmDialog = useConfirmDialog()
  const [showModal, setShowModal] = useState(false)
  const [editingUser, setEditingUser] = useState(null)
  const [formUsername, setFormUsername] = useState('')
  const [formPassword, setFormPassword] = useState('')
  const [formRole, setFormRole] = useState('trainer')
  const [formForceChange, setFormForceChange] = useState(false)
  const { user: currentUser } = useAuth()

  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: getUsers })
  const activeAdminCount = users.filter((u) => u.role === 'admin' && u.is_active).length
  const isLastActiveAdmin = (u) => u?.role === 'admin' && u?.is_active && activeAdminCount <= 1

  const createMut = useMutation({
    mutationFn: (data) => createUser(data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['users'] }); toast.success(t('settings.users.userCreated')); setShowModal(false) },
    onError: (e) => toast.error(e.response?.data?.detail || t('common.error')),
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }) => updateUser(id, data),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['users'] }); toast.success(t('settings.users.userUpdated')); setShowModal(false); setEditingUser(null) },
    onError: (e) => toast.error(e.response?.data?.detail || t('common.error')),
  })
  const deleteMut = useMutation({
    mutationFn: (id) => deleteUser(id),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['users'] }); toast.success(t('settings.users.userDeleted')) },
    onError: (e) => toast.error(e.response?.data?.detail || t('common.error')),
  })
  const logoutOthersMut = useMutation({
    mutationFn: () => logoutOtherDevices(),
    onSuccess: () => toast.success(t('settings.users.otherDevicesSignedOut')),
    onError: (e) => toast.error(e.response?.data?.detail || t('common.error')),
  })
  const changePwMut = useMutation({
    mutationFn: (data) => changePassword(data),
    onSuccess: () => { toast.success(t('settings.users.passwordChanged')); setCurrentPw(''); setNewPw('') },
    onError: (e) => toast.error(e.response?.data?.detail || t('common.error')),
  })

  const openCreate = () => {
    setEditingUser(null)
    setFormUsername('')
    setFormPassword('')
    setFormRole('trainer')
    setFormForceChange(false)
    setShowModal(true)
  }
  const openEdit = (u) => { setEditingUser(u); setFormUsername(u.username); setFormPassword(''); setFormRole(u.role); setShowModal(true) }
  const handleSubmit = (e) => {
    e.preventDefault()
    if (editingUser) {
      const data = {}
      if (formUsername !== editingUser.username) data.username = formUsername
      if (formPassword) data.password = formPassword
      if (formRole !== editingUser.role) data.role = formRole
      updateMut.mutate({ id: editingUser.id, data })
    } else {
      createMut.mutate({
        username: formUsername,
        password: formPassword,
        role: formRole,
        must_change_password: formForceChange,
      })
    }
  }

  return (
    <>
      <section className="space-y-1">
        <div className="flex items-center justify-between px-4 pb-1.5">
          <h2 className="text-footnote text-text-secondary">{t('settings.users.title')}</h2>
          <button onClick={openCreate} className="flex min-h-[32px] items-center gap-1 text-subheadline font-semibold text-tint">
            <Plus size={14} /> {t('settings.users.addUser')}
          </button>
        </div>
        <SettingsCard>
          {users.map((u, i) => {
            const lastActiveAdmin = isLastActiveAdmin(u)
            return (
              <SettingsRow key={u.id} label={u.username} description={`${u.role} · ${u.is_active ? t('settings.users.active') : t('settings.users.inactive')}`} last={i === users.length - 1}>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => updateMut.mutate({ id: u.id, data: { is_active: !u.is_active } })}
                    disabled={lastActiveAdmin}
                    className="grid h-11 w-9 place-items-center text-text-secondary disabled:cursor-not-allowed disabled:opacity-35"
                    title={lastActiveAdmin ? t('settings.users.lastAdminRequired') : (u.is_active ? t('settings.users.deactivate') : t('settings.users.activate'))}
                  >
                    {u.is_active ? <UserCheck size={15} /> : <UserX size={15} />}
                  </button>
                  <button onClick={() => openEdit(u)} aria-label={t('common.edit')} className="grid h-11 w-9 place-items-center text-text-secondary"><Pencil size={15} /></button>
                  {u.id !== currentUser?.id && (
                    <button onClick={async () => {
                      const confirmed = await confirmDialog({
                        title: t('common.delete'),
                        message: t('settings.users.deleteConfirm'),
                        confirmLabel: t('common.delete'),
                        destructive: true,
                      })
                      if (confirmed) deleteMut.mutate(u.id)
                    }} aria-label={t('common.delete')} className="grid h-11 w-9 place-items-center text-red"><Trash2 size={15} /></button>
                  )}
                </div>
              </SettingsRow>
            )
          })}
        </SettingsCard>
      </section>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title={editingUser ? t('common.edit') : t('settings.users.addUser')} size="sm">
        <form onSubmit={handleSubmit} className="space-y-4 p-4">
          <div>
            <label className="text-xs text-text-secondary mb-1 block">{t('settings.users.username')}</label>
            <input type="text" name="new-user-username" id="user-form-username" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={formUsername} onChange={(e) => setFormUsername(e.target.value)} className="input w-full" required />
          </div>
          <div>
            <label className="text-xs text-text-secondary mb-1 block">{t('settings.users.password')}{editingUser && ' (leave blank to keep)'}</label>
            <input type="password" name="new-user-password" id="user-form-password" autoComplete="new-password" value={formPassword} onChange={(e) => setFormPassword(e.target.value)} className="input w-full" {...(!editingUser && { required: true })} />
          </div>
          <div>
            <label className="text-xs text-text-secondary mb-1 block">{t('settings.users.role')}</label>
            <select value={formRole} onChange={(e) => setFormRole(e.target.value)} className="select w-full">
              <option value="trainer" disabled={isLastActiveAdmin(editingUser)}>{t('settings.users.trainer')}</option>
              <option value="admin">{t('settings.users.admin')}</option>
            </select>
            {isLastActiveAdmin(editingUser) && (
              <p className="mt-1 text-xs text-text-muted">{t('settings.users.lastAdminRequired')}</p>
            )}
          </div>
          {!editingUser && (
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={formForceChange}
                onChange={(e) => setFormForceChange(e.target.checked)}
              />
              <span>{t('settings.users.forcePasswordChange')}</span>
            </label>
          )}
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={() => setShowModal(false)} className="btn-ghost flex-1">{t('common.cancel')}</button>
            <button type="submit" disabled={createMut.isPending || updateMut.isPending} className="btn-primary flex-1">
              {editingUser ? t('common.save') : t('settings.users.addUser')}
            </button>
          </div>
        </form>
      </Modal>
    </>
  )
}
