import { useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { getSets } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { useCatalogQuery } from '../offline/carddb/useCatalogQuery.jsx'
import { ownedFromQueryClient } from '../offline/carddb/owned.js'
import { useOffline } from '../offline/useOffline'
import { useCardDb } from '../offline/carddb/useCardDb.jsx'
import { useQueryClient } from '@tanstack/react-query'
import ListRow from '../components/ios/ListRow'
import ListSection from '../components/ios/ListSection'
import LanguageBadge from '../components/ios/LanguageBadge'
import HeaderBloom from '../components/ios/HeaderBloom'
import { colourFor } from '../components/ios/pokemon'
import { useNavBar } from '../navigation/useNavBar'
import { useVisibleTcgdexLanguages } from '../hooks/useVisibleTcgdexLanguages'
import { useSetsDefaultLanguage } from '../hooks/useSetsDefaultLanguage'
import { getTcgdexLanguage, normalizeTcgdexLanguage } from '../utils/tcgdexLanguages'
import {
  legacySetsRedirect,
  resolveSetsLanding,
  setsLanguagePath,
  storedFilterLanguage,
  summariseLanguages,
} from '../utils/setsLanguage'

// A language list request that never answers (Airplane Mode, requests hanging) must not hold the page.
const LANGUAGE_LIST_PATIENCE_MS = 3000

/**
 * The language codes the user can browse, the language to fall back on, and whether they are still
 * loading. The server's visible list wins. When it can't be had (offline with no saved copy, a failed
 * request) the languages with a downloaded card database stand in, so the page lists what has offline
 * data, or goes straight to the series when that is a single language.
 */
export function useSetsLanguageChoices() {
  const { settings } = useSettings()
  const visible = useVisibleTcgdexLanguages()
  const { languages: downloaded } = useCardDb()
  const [gaveUp, setGaveUp] = useState(false)
  useEffect(() => {
    if (!visible.isLoading) return undefined
    const timer = window.setTimeout(() => setGaveUp(true), LANGUAGE_LIST_PATIENCE_MS)
    return () => window.clearTimeout(timer)
  }, [visible.isLoading])
  const visibleCodes = useMemo(() => visible.map(language => language.code), [visible])
  const downloadedCodes = useMemo(
    () => Object.entries(downloaded ?? {}).filter(([, state]) => state?.meta).map(([code]) => normalizeTcgdexLanguage(code, '')).filter(Boolean),
    [downloaded],
  )
  return {
    codes: visibleCodes.length ? visibleCodes : downloadedCodes,
    known: visibleCodes.length > 0,
    loading: visible.isLoading && !gaveUp,
    fallbackCode: normalizeTcgdexLanguage(settings.language || 'en', 'en'),
  }
}

/** Old `/sets/series/:key` URLs: into the language they were filtered to. */
export function LegacySeriesRedirect() {
  const location = useLocation()
  const { settings } = useSettings()
  const { codes, loading, fallbackCode } = useSetsLanguageChoices()
  if (loading) return null
  const visibleCodes = codes.length ? codes : [fallbackCode]
  const to = legacySetsRedirect({
    pathname: location.pathname,
    search: location.search,
    storedLang: storedFilterLanguage(settings.set_overview_filters),
    visibleCodes,
  })
  return <Navigate to={to ?? '/sets'} replace />
}

/**
 * `/sets`: the language list when the user sees two or more card languages, otherwise a redirect
 * (replace, so Back leaves Sets) into the one language or the saved default.
 */
export default function SetsLanguages() {
  const { t } = useSettings()
  const location = useLocation()
  const offline = useOffline()
  const queryClient = useQueryClient()
  const { settings } = useSettings()
  const { language: defaultSetting } = useSetsDefaultLanguage()
  const { codes, loading, fallbackCode } = useSetsLanguageChoices()
  const navBar = useMemo(() => ({ title: t('nav.sets') }), [t])
  useNavBar(navBar)

  const landing = resolveSetsLanding({ loading, codes, fallbackCode, defaultSetting })
  const selecting = landing.kind === 'select'
  const { data: sets } = useCatalogQuery({
    queryKey: ['sets', 'all'],
    queryFn: () => getSets({ lang: 'all' }).then(r => r.data),
    offlineFn: cardDb => cardDb.sets({ lang: 'all', ownedCounts: ownedFromQueryClient(queryClient).ownedCounts }),
    enabled: selecting,
  })
  const rows = useMemo(() => (selecting ? summariseLanguages(sets, landing.codes) : []), [landing.codes, selecting, sets])

  if (loading) return <div className="skeleton h-40 rounded-[18px]" data-testid="sets-languages-loading" />
  const legacy = legacySetsRedirect({
    pathname: location.pathname,
    search: location.search,
    storedLang: storedFilterLanguage(settings.set_overview_filters),
    visibleCodes: landing.kind === 'select' ? landing.codes : [landing.lang],
  })
  if (legacy) return <Navigate to={legacy} replace />
  if (landing.kind === 'redirect') return <Navigate to={setsLanguagePath(landing.lang)} replace />

  return (
    <div className="relative isolate space-y-4 pb-2" data-testid="sets-languages">
      <HeaderBloom colour={colourFor('sets')} />
      <div className="pt-1">
        <h1 className="text-title-2 font-display">{t('sets.chooseLanguage')}</h1>
        <p className="text-subheadline text-text-secondary">{t('sets.chooseLanguageDesc')}</p>
      </div>
      <ListSection className="mx-0">
        {rows.map(row => {
          const notSaved = offline && row.setCount === 0
          const ownedPart = row.ownedKnown ? ` · ${t('ios.ownedOfTotal').replace('{owned}', row.owned).replace('{total}', row.total)} ${t('sets.cards')}` : ''
          return (
            <ListRow
              key={row.code}
              testId={`sets-language-${row.code}`}
              leading={<LanguageBadge code={row.code} />}
              title={getTcgdexLanguage(row.code).name}
              subtitle={notSaved ? t('sync.notSavedYet') : `${t('ios.setsCount').replace('{count}', row.setCount)}${ownedPart}`}
              to={notSaved ? undefined : setsLanguagePath(row.code)}
              disabled={notSaved}
            />
          )
        })}
      </ListSection>
    </div>
  )
}
