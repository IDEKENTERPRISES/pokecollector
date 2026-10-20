import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react'
import en from '../i18n/en'
import { priceFieldFromPrimary } from '../utils/prices'
import { normalizeTcgdexLanguageCsv } from '../utils/tcgdexLanguages'
import { useAuth } from './AuthContext'
import { maskValue, useHideValues } from '../components/ios/hideValues'
import { loadSettingsWithCache, readCachedRate, readCachedSettings, withRateCache } from '../offline/settingsCache'

const TRANSLATION_LOADERS = {
  de: () => import('../i18n/de'),
  zh: () => import('../i18n/zh'),
  'zh-cn': () => import('../i18n/zhCn'),
  sv: () => import('../i18n/sv'),
  fr: () => import('../i18n/fr'),
  nl: () => import('../i18n/nl'),
  es: () => import('../i18n/es'),
  'es-mx': () => import('../i18n/esMx'),
  it: () => import('../i18n/it'),
  pt: () => import('../i18n/pt'),
  'pt-br': () => import('../i18n/ptBr'),
  'pt-pt': () => import('../i18n/ptPt'),
  pl: () => import('../i18n/pl'),
  ru: () => import('../i18n/ru'),
  ja: () => import('../i18n/ja'),
  ko: () => import('../i18n/ko'),
  id: () => import('../i18n/id'),
  th: () => import('../i18n/th'),
  'zh-tw': () => import('../i18n/zhTw'),
}
const SUPPORTED_LANGUAGES = new Set(['en', ...Object.keys(TRANSLATION_LOADERS)])

const DEFAULT_SETTINGS = {
  language: 'en',
  price_display: '["trend", "avg", "avg1", "avg7", "avg30", "low"]',
  price_primary: 'trend',
  portfolio_display_mode: 'portfolio_value',
  tcgdex_sync_languages: 'en,de',
  tcgdex_digital_sets_enabled: 'true',
  cross_language_price_fallback: 'true',
  cross_language_image_fallback: 'true',
  set_overview_filters: '{}',
  hidden_set_ids: '[]',
  debug_mode: 'false',
  public_profiles_enabled: 'false',
  prefer_own_card_photos: 'false',
}

const LANGUAGE_STORAGE_KEY = 'app_language'

// The backend stays the source of truth for the language, but it only answers after
// auth resolves. Mirroring the choice locally lets the first paint (and a failed or
// unauthenticated settings fetch) use the language the user actually picked.
function readCachedLanguage() {
  try {
    const cached = localStorage.getItem(LANGUAGE_STORAGE_KEY)
    return cached && SUPPORTED_LANGUAGES.has(cached) ? cached : null
  } catch {
    return null
  }
}

function cacheLanguage(language) {
  if (!language || !SUPPORTED_LANGUAGES.has(language)) return
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    // Storage can be unavailable (private mode, blocked cookies); the backend copy still holds.
  }
}

function initialSettings(userId) {
  const cached = readCachedSettings(userId) || {}
  return {
    ...DEFAULT_SETTINGS,
    ...cached,
    language: readCachedLanguage() || cached.language || DEFAULT_SETTINGS.language,
  }
}

function currencySymbolFor(code) {
  try {
    const part = new Intl.NumberFormat('en', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0)
      .find(p => p.type === 'currency')
    return part?.value || code
  } catch {
    return code
  }
}

const SettingsContext = createContext(null)

export function SettingsProvider({ children }) {
  const { user, loading: authLoading, multiUser } = useAuth()
  const [settings, setSettings] = useState(() => initialSettings(user?.id))
  const [loaded, setLoaded] = useState(false)
  const [exchangeRate, setExchangeRate] = useState(1.0)
  const [exchangeRateReady, setExchangeRateReady] = useState(true)
  const [exchangeRateCurrency, setExchangeRateCurrency] = useState('EUR')
  const [usdToEurRate, setUsdToEurRate] = useState(0.91)
  const [loadedTranslations, setLoadedTranslations] = useState({ en })

  // Load settings from backend once auth mode is known. Single-user mode has no
  // token, but the backend still auto-authenticates the bootstrap admin.
  useEffect(() => {
    if (authLoading) return

    setLoaded(false)
    const token = localStorage.getItem('token')
    if (multiUser && !token) {
      setSettings(initialSettings(user?.id))
      setLoaded(true)
      return
    }

    const headers = token && multiUser ? { Authorization: `Bearer ${token}` } : {}
    // Stale-while-revalidate: show this user's cached settings now (the user is only known
    // here, not at mount), then let the network copy replace them. A hanging offline request
    // times out and loadSettingsWithCache falls back to the same cache.
    const cached = readCachedSettings(user?.id)
    if (cached) {
      setSettings(prev => ({
        ...prev,
        ...cached,
        language: readCachedLanguage() || cached.language || prev.language,
      }))
    }
    loadSettingsWithCache(user?.id, signal => fetch('/api/settings/', { headers, signal })
      .then(r => {
        if (!r.ok) throw new Error('Settings load failed')
        return r.json()
      }))
      .then(data => {
        const language = data.language === 'zh' ? 'zh-cn' : data.language
        cacheLanguage(language)
        setSettings(prev => ({
          ...prev,
          ...data,
          language: language || prev.language,
          tcgdex_sync_languages: normalizeTcgdexLanguageCsv(data.tcgdex_sync_languages || prev.tcgdex_sync_languages),
        }))
        setLoaded(true)
      })
      .catch(() => {
        // Backend not available, use defaults
        setLoaded(true)
      })
  }, [authLoading, multiUser, user?.id])

  const lang = settings.language || DEFAULT_SETTINGS.language
  useEffect(() => {
    if (lang === 'en' || loadedTranslations[lang]) return
    const loader = TRANSLATION_LOADERS[lang]
    if (!loader) return

    let cancelled = false
    loader()
      .then(module => {
        if (!cancelled) {
          setLoadedTranslations(previous => ({ ...previous, [lang]: module.default }))
        }
      })
      .catch(() => {
        // English remains available if a language chunk cannot be loaded.
      })
    return () => { cancelled = true }
  }, [lang, loadedTranslations])

  // Fetch exchange rates through the backend to avoid browser CORS/redirect issues.
  // Most app prices are stored in EUR; TCGPlayer prices are stored in USD and need the inverse path.
  useEffect(() => {
    const token = localStorage.getItem('token')
    if (authLoading || (multiUser && !token)) return

    // Resolves to null when the backend has no rate (unknown currency and API unreachable);
    // a failed or timed-out request falls back to the last cached rate for the pair.
    const fetchExchangeRate = async (from, to) => {
      const headers = token && multiUser ? { Authorization: `Bearer ${token}` } : {}
      return withRateCache(user?.id, from, to, async signal => {
        const response = await fetch(`/api/settings/exchange-rate?from=${from}&to=${to}`, {
          headers,
          signal,
        })
        if (!response.ok) throw new Error('Exchange rate lookup failed')
        const data = await response.json()
        return Number(data.rate) || null
      })
    }

    const curr = (settings.currency || 'EUR').toUpperCase()
    let cancelled = false
    if (curr === 'EUR') {
      setExchangeRateReady(true)
      setExchangeRateCurrency('EUR')
      setExchangeRate(1.0)
    } else {
      // A cached rate is applied at once (ready); the network refresh replaces it.
      const cachedRate = readCachedRate(user?.id, 'EUR', curr)?.rate
      setExchangeRateReady(Boolean(cachedRate))
      setExchangeRateCurrency(cachedRate ? curr : null)
      if (cachedRate) setExchangeRate(cachedRate)
      fetchExchangeRate('EUR', curr).then(rate => {
        if (cancelled) return
        // Without a rate, show EUR amounts rather than mislabeled converted ones.
        setExchangeRate(rate ?? 1.0)
        setExchangeRateCurrency(rate ? curr : 'EUR')
        setExchangeRateReady(true)
      })
    }
    // TCGPlayer prices are stored in USD; convert them to the display currency.
    if (curr === 'USD') {
      setUsdToEurRate(1.0)
    } else {
      const cachedUsd = readCachedRate(user?.id, 'USD', curr)?.rate
      if (cachedUsd) setUsdToEurRate(cachedUsd)
      fetchExchangeRate('USD', curr).then(rate => {
        if (!cancelled) setUsdToEurRate(rate ?? (curr === 'EUR' ? 0.91 : null))
      })
    }
    return () => { cancelled = true }
  }, [settings.currency, authLoading, multiUser, user?.id])

  // Update one or more settings
  const updateSettings = useCallback(async (updates) => {
    const next = { ...settings, ...updates }
    setSettings(next)
    try {
      const token = localStorage.getItem('token')
      const headers = { 'Content-Type': 'application/json' }
      if (token && multiUser) headers.Authorization = `Bearer ${token}`

      const resp = await fetch('/api/settings/', {
        method: 'PUT',
        headers,
        body: JSON.stringify(updates),
      })
      if (!resp.ok) throw new Error('Save failed')
      const saved = await resp.json()
      const language = saved.language === 'zh' ? 'zh-cn' : saved.language
      cacheLanguage(language)
      setSettings(prev => ({
        ...prev,
        ...saved,
        language: language || prev.language,
      }))
    } catch (err) {
      setSettings(settings)
      console.error('Failed to save settings:', err)
      throw err
    }
  }, [settings, multiUser])

  const msgs = loadedTranslations[lang] || en

  // Translation helper
  const t = useCallback((path) => {
    const parts = path.split('.')
    let val = msgs
    for (const part of parts) {
      val = val?.[part]
      if (val === undefined) break
    }
    if (val === undefined) {
      // Fallback to English
      let fallback = en
      for (const part of parts) {
        fallback = fallback?.[part]
        if (fallback === undefined) break
      }
      return fallback ?? path
    }
    return val
  }, [msgs])

  // Parse price_display JSON safely
  const getPriceDisplay = useCallback(() => {
    try {
      const val = settings.price_display
      if (Array.isArray(val)) return val
      return JSON.parse(val || '["trend", "avg", "avg1", "avg7", "avg30", "low"]')
    } catch {
      return ['trend', 'avg', 'avg1', 'avg7', 'avg30', 'low']
    }
  }, [settings.price_display])

  const getPricePrimary = useCallback(() => {
    return settings.price_primary || 'trend'
  }, [settings.price_primary])

  const requestedCurrency = (settings.currency || 'EUR').toUpperCase()
  // If no rate could be loaded, fall back to showing EUR so labels match the amounts.
  const currency = exchangeRateReady && exchangeRateCurrency && exchangeRateCurrency !== requestedCurrency
    ? exchangeRateCurrency
    : requestedCurrency
  const currencySymbol = useMemo(() => currencySymbolFor(currency), [currency])
  const moneyExchangeRateReady = currency === 'EUR' || (exchangeRateReady && exchangeRateCurrency === currency)
  const pricePrimary = getPricePrimary()
  const pricePrimaryField = priceFieldFromPrimary(pricePrimary)

  // Hide values (Q16): both formatters return display strings only, so masking here cannot
  // reach a calculation or an input (checked: no caller parses their result).
  const { hidden: valuesHidden } = useHideValues()

  const formatPrice = useCallback((eurAmount) => {
    if (eurAmount == null || isNaN(Number(eurAmount))) return '-'
    const converted = Number(eurAmount) * exchangeRate
    return maskValue(`${currencySymbol}${converted.toFixed(2)}`, valuesHidden)
  }, [exchangeRate, currencySymbol, valuesHidden])

  const formatCompactPrice = useCallback((eurAmount) => {
    if (eurAmount == null || isNaN(Number(eurAmount))) return '-'
    return maskValue(compactAmount(Number(eurAmount) * exchangeRate, currencySymbol), valuesHidden)
  }, [exchangeRate, currencySymbol, valuesHidden])

  const formatUsdPrice = useCallback((usdAmount) => {
    if (usdAmount == null || isNaN(Number(usdAmount))) return '-'
    // No USD rate for the display currency: show the original USD amount.
    if (usdToEurRate == null) return maskValue(`$${Number(usdAmount).toFixed(2)}`, valuesHidden)
    const converted = Number(usdAmount) * usdToEurRate
    return maskValue(`${currencySymbol}${converted.toFixed(2)}`, valuesHidden)
  }, [currency, currencySymbol, usdToEurRate, valuesHidden])

  return (
    <SettingsContext.Provider value={{
      settings,
      updateSettings,
      t,
      language: lang,
      priceDisplay: getPriceDisplay(),
      pricePrimary,
      pricePrimaryField,
      loaded,
      currency,
      currencySymbol,
      exchangeRate,
      exchangeRateReady: moneyExchangeRateReady,
      formatPrice,
      formatCompactPrice,
      formatUsdPrice,
    }}>
      {children}
    </SettingsContext.Provider>
  )
}

export { useHideValues }

/**
 * Compact money for tiles and summaries: 1,000 and over becomes £1k, £1.1k … £12.5k, then £1.2M
 * (one decimal, dropped when it is .0, the sign kept). Below 1,000 the full amount is shown.
 * `amount` is already in the display currency.
 */
export function compactAmount(amount, symbol) {
  const sign = amount < 0 ? '-' : ''
  const abs = Math.abs(amount)
  if (abs < 1000) return `${sign}${symbol}${abs.toFixed(2)}`
  const trim = value => String(value).replace(/.0$/, '')
  const thousands = Math.round(abs / 100) / 10
  if (thousands < 1000) return `${sign}${symbol}${trim(thousands.toFixed(1))}k`
  return `${sign}${symbol}${trim((Math.round(abs / 100000) / 10).toFixed(1))}M`
}

export function useSettings() {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider')
  return ctx
}

export default SettingsContext
