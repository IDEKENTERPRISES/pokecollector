import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import clsx from 'clsx'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Bell, BellOff, Filter, ChevronUp, ChevronDown, Eye, EyeOff } from 'lucide-react'
import { getSets, markSetsSeen } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'
import { resolveSetImageUrl } from '../utils/imageUrl'
import TcgdexLanguageSelect from '../components/TcgdexLanguageSelect'
import { useVisibleTcgdexLanguages } from '../hooks/useVisibleTcgdexLanguages'
import { normalizeTcgdexLanguage, tcgdexLanguageBadgeClass, tcgdexLanguageLabel } from '../utils/tcgdexLanguages'
import SeriesTile from '../components/ios/SeriesTile'
import SetTile from '../components/ios/SetTile'
import HpBar from '../components/ios/HpBar'
import HeaderBloom from '../components/ios/HeaderBloom'
import SearchField from '../components/ios/SearchField'
import SegmentedControl from '../components/ios/SegmentedControl'
import PageSheet from '../components/ios/PageSheet'
import Menu from '../components/ios/Menu'
import { colourFor } from '../components/ios/pokemon'
import { useNavBar } from '../navigation/useNavBar'
import { useSetsView } from '../hooks/useSetsView'
import { groupSetsBySeries } from '../utils/setSeries'
import { setMatchesSearch } from '../utils/textSearch'
import { getSavedListScrollPosition, isSavedPositionForLocation, useListScrollRestoration } from '../hooks/useListScrollRestoration'
import {
  hasFilterUrlState,
  readFilterUrlState,
  writeFilterUrlState,
} from '../utils/filterUrlState'

const DEFAULT_SET_FILTERS = {
  search: '',
  series: '',
  sortBy: 'release_date',
  sortOrder: 'desc',
  progressFilter: 'all',
  langFilter: 'all',
  showHiddenSets: false,
}

const SET_FILTER_OPTIONS = {
  sortBy: new Set(['release_date', 'name', 'total', 'progress']),
  sortOrder: new Set(['asc', 'desc']),
  progressFilter: new Set(['all', 'started', 'complete']),
}

const SORT_OPTIONS = ['release_date', 'name', 'total', 'progress']
const SORT_LABEL_KEYS = {
  release_date: 'sets.sortReleaseDate',
  name: 'sets.sortName',
  total: 'sets.sortCardCount',
  progress: 'sets.sortProgress',
}

const parseJsonSetting = (value, fallback) => {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

const normalizeSetFilters = (value, defaultLangFilter = DEFAULT_SET_FILTERS.langFilter) => {
  const parsed = parseJsonSetting(value, {})
  return {
    search: typeof parsed.search === 'string' ? parsed.search : DEFAULT_SET_FILTERS.search,
    series: typeof parsed.series === 'string' ? parsed.series : DEFAULT_SET_FILTERS.series,
    sortBy: SET_FILTER_OPTIONS.sortBy.has(parsed.sortBy) ? parsed.sortBy : DEFAULT_SET_FILTERS.sortBy,
    sortOrder: SET_FILTER_OPTIONS.sortOrder.has(parsed.sortOrder) ? parsed.sortOrder : DEFAULT_SET_FILTERS.sortOrder,
    progressFilter: SET_FILTER_OPTIONS.progressFilter.has(parsed.progressFilter) ? parsed.progressFilter : DEFAULT_SET_FILTERS.progressFilter,
    langFilter: typeof parsed.langFilter === 'string' && parsed.langFilter ? parsed.langFilter : defaultLangFilter,
    showHiddenSets: parsed.showHiddenSets === true,
  }
}

const normalizeHiddenSetIds = (value) => {
  const parsed = parseJsonSetting(value, [])
  if (!Array.isArray(parsed)) return []
  return [...new Set(parsed.filter(Boolean).map(String))].sort()
}

export default function Sets() {
  const navigate = useNavigate()
  const { seriesKey: rawSeriesKey } = useParams()
  const seriesKey = rawSeriesKey ? decodeURIComponent(rawSeriesKey) : null
  const { view, setView } = useSetsView()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const { t, settings, updateSettings, loaded: settingsLoaded } = useSettings()
  const visibleLanguages = useVisibleTcgdexLanguages()
  const [filtersHydrated, setFiltersHydrated] = useState(false)
  const [search, setSearch] = useState(DEFAULT_SET_FILTERS.search)
  const [series, setSeries] = useState(DEFAULT_SET_FILTERS.series)
  const [sortBy, setSortBy] = useState(DEFAULT_SET_FILTERS.sortBy)
  const [sortOrder, setSortOrder] = useState(DEFAULT_SET_FILTERS.sortOrder)
  const [progressFilter, setProgressFilter] = useState(DEFAULT_SET_FILTERS.progressFilter)
  const [langFilter, setLangFilter] = useState(DEFAULT_SET_FILTERS.langFilter)
  const [showHiddenSets, setShowHiddenSets] = useState(DEFAULT_SET_FILTERS.showHiddenSets)
  const [hiddenSetIds, setHiddenSetIds] = useState([])
  const savedFilterStateRef = useRef('')
  const savedHiddenSetIdsRef = useRef('')
  const filterSaveTimeoutRef = useRef(null)
  const queryClient = useQueryClient()
  const filterState = useMemo(() => ({
    search,
    series,
    sortBy,
    sortOrder,
    progressFilter,
    langFilter,
    showHiddenSets,
  }), [langFilter, progressFilter, search, series, showHiddenSets, sortBy, sortOrder])
  const serializedFilterState = useMemo(() => JSON.stringify(filterState), [filterState])
  const persistFilterState = useCallback((serializedFilters) => {
    savedFilterStateRef.current = serializedFilters
    updateSettings({ set_overview_filters: serializedFilters })
      .catch(() => {
        savedFilterStateRef.current = ''
        toast.error(t('sets.savePreferencesFailed'))
      })
  }, [t, updateSettings])

  const { data: sets = [], isLoading } = useQuery({
    queryKey: ['sets', langFilter],
    queryFn: () => getSets({ lang: langFilter }).then(r => r.data),
    enabled: filtersHydrated,
  })
  const { saveScrollPosition, createDetailNavigationState } = useListScrollRestoration({
    key: 'sets',
    isReady: filtersHydrated && !isLoading && sets.length > 0,
    listState: filtersHydrated ? filterState : null,
  })

  const openSet = (set) => {
    const anchorId = `set-${set.id}`
    saveScrollPosition(anchorId, filterState)
    if (savedFilterStateRef.current !== serializedFilterState) {
      clearTimeout(filterSaveTimeoutRef.current)
      filterSaveTimeoutRef.current = null
      persistFilterState(serializedFilterState)
    }
    navigate(`/sets/${set.id}`, { state: createDetailNavigationState(anchorId) })
  }

  const markSeenMutation = useMutation({
    mutationFn: markSetsSeen,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sets'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard'] })
      toast.success(t('sets.markedSeen'))
    },
  })

  const visibleLanguageCodes = useMemo(() => visibleLanguages.map(language => language.code), [visibleLanguages])
  const preferredCatalogueLanguage = normalizeTcgdexLanguage(settings.language || 'en', 'en')
  const defaultLangFilter = visibleLanguageCodes.includes(preferredCatalogueLanguage)
    ? preferredCatalogueLanguage
    : DEFAULT_SET_FILTERS.langFilter
  const filterDefinitions = useMemo(() => ({
    series: { param: 'series', default: DEFAULT_SET_FILTERS.series },
    progressFilter: { param: 'progress', default: DEFAULT_SET_FILTERS.progressFilter },
    langFilter: { param: 'lang', default: defaultLangFilter },
    showHiddenSets: { param: 'show_hidden', type: 'boolean', default: false },
  }), [defaultLangFilter])

  useEffect(() => {
    if (!settingsLoaded) setFiltersHydrated(false)
  }, [settingsLoaded])

  useEffect(() => {
    if (!settingsLoaded || visibleLanguages.isLoading || filtersHydrated) return
    const savedPosition = getSavedListScrollPosition('sets')
    const storedFilters = normalizeSetFilters(settings.set_overview_filters, defaultLangFilter)
    const activeFilters = normalizeSetFilters(
      isSavedPositionForLocation(savedPosition, location)
        ? savedPosition.listState
        : storedFilters,
      defaultLangFilter,
    )
    const storedPanelFilters = {
      series: activeFilters.series,
      progressFilter: activeFilters.progressFilter,
      langFilter: activeFilters.langFilter,
      showHiddenSets: activeFilters.showHiddenSets,
    }
    const urlPanelFilters = hasFilterUrlState(searchParams, filterDefinitions)
      ? readFilterUrlState(searchParams, filterDefinitions)
      : storedPanelFilters
    const activePanelFilters = {
      ...urlPanelFilters,
      progressFilter: SET_FILTER_OPTIONS.progressFilter.has(urlPanelFilters.progressFilter)
        ? urlPanelFilters.progressFilter
        : DEFAULT_SET_FILTERS.progressFilter,
      langFilter: urlPanelFilters.langFilter === 'all' || visibleLanguageCodes.includes(urlPanelFilters.langFilter)
        ? urlPanelFilters.langFilter
        : defaultLangFilter,
    }
    const savedHiddenIds = normalizeHiddenSetIds(settings.hidden_set_ids)
    setSearch(activeFilters.search)
    setSeries(activePanelFilters.series)
    setSortBy(activeFilters.sortBy)
    setSortOrder(activeFilters.sortOrder)
    setProgressFilter(activePanelFilters.progressFilter)
    setLangFilter(activePanelFilters.langFilter)
    setShowHiddenSets(activePanelFilters.showHiddenSets)
    setHiddenSetIds(savedHiddenIds)
    savedFilterStateRef.current = JSON.stringify(storedFilters)
    savedHiddenSetIdsRef.current = JSON.stringify(savedHiddenIds)
    const normalizedParams = writeFilterUrlState(searchParams, filterDefinitions, activePanelFilters)
    if (normalizedParams.toString() !== searchParams.toString()) {
      setSearchParams(normalizedParams, { replace: true })
    }
    setFiltersHydrated(true)
  }, [defaultLangFilter, filterDefinitions, filtersHydrated, location, searchParams, setSearchParams, settings, settingsLoaded, visibleLanguageCodes, visibleLanguages.isLoading])

  const filterUrlKey = searchParams.toString()
  useEffect(() => {
    if (!filtersHydrated || visibleLanguages.isLoading) return
    const urlFilters = readFilterUrlState(searchParams, filterDefinitions)
    const nextFilters = {
      ...urlFilters,
      progressFilter: SET_FILTER_OPTIONS.progressFilter.has(urlFilters.progressFilter)
        ? urlFilters.progressFilter
        : DEFAULT_SET_FILTERS.progressFilter,
      langFilter: urlFilters.langFilter === 'all' || visibleLanguageCodes.includes(urlFilters.langFilter)
        ? urlFilters.langFilter
        : defaultLangFilter,
    }
    setSeries(nextFilters.series)
    setProgressFilter(nextFilters.progressFilter)
    setLangFilter(nextFilters.langFilter)
    setShowHiddenSets(nextFilters.showHiddenSets)

    const normalizedParams = writeFilterUrlState(searchParams, filterDefinitions, nextFilters)
    if (normalizedParams.toString() !== searchParams.toString()) {
      setSearchParams(normalizedParams, { replace: true })
    }
  }, [defaultLangFilter, filterDefinitions, filterUrlKey, filtersHydrated, searchParams, setSearchParams, visibleLanguageCodes, visibleLanguages.isLoading])

  useEffect(() => {
    if (!settingsLoaded || !filtersHydrated || savedFilterStateRef.current === serializedFilterState) return
    filterSaveTimeoutRef.current = setTimeout(() => {
      filterSaveTimeoutRef.current = null
      persistFilterState(serializedFilterState)
    }, 400)
    return () => {
      clearTimeout(filterSaveTimeoutRef.current)
      filterSaveTimeoutRef.current = null
    }
  }, [filtersHydrated, persistFilterState, serializedFilterState, settingsLoaded])

  useEffect(() => {
    if (!settingsLoaded || !filtersHydrated) return
    const serializedHiddenSetIds = JSON.stringify(hiddenSetIds)
    if (savedHiddenSetIdsRef.current === serializedHiddenSetIds) return
    savedHiddenSetIdsRef.current = serializedHiddenSetIds
    updateSettings({ hidden_set_ids: serializedHiddenSetIds })
      .catch(() => {
        savedHiddenSetIdsRef.current = ''
        toast.error(t('sets.savePreferencesFailed'))
      })
  }, [filtersHydrated, hiddenSetIds, settingsLoaded, t, updateSettings])

  const allSeries = [...new Set(sets.map(s => s.series).filter(Boolean))].sort()
  const hiddenSetIdSet = useMemo(() => new Set(hiddenSetIds), [hiddenSetIds])
  const hiddenSetCount = sets.filter(set => hiddenSetIdSet.has(String(set.id))).length
  const newSets = sets.filter(s => s.is_new && (showHiddenSets || !hiddenSetIdSet.has(String(s.id))))

  const filtered = useMemo(() => {
    let result = sets.filter(s => {
      if (!showHiddenSets && hiddenSetIdSet.has(String(s.id))) return false
      if (search && !setMatchesSearch(s, search)) return false
      if (series && s.series !== series) return false
      const owned = s.owned_count ?? 0
      const total = s.total ?? 0
      if (progressFilter === 'started' && owned === 0) return false
      if (progressFilter === 'complete' && (owned < total || total === 0)) return false
      return true
    })

    result = [...result].sort((a, b) => {
      let valA, valB
      const owned_a = a.owned_count ?? 0
      const owned_b = b.owned_count ?? 0
      switch (sortBy) {
        case 'release_date': valA = a.release_date || ''; valB = b.release_date || ''; break
        case 'name': valA = a.name.toLowerCase(); valB = b.name.toLowerCase(); break
        case 'total': valA = a.total ?? 0; valB = b.total ?? 0; break
        case 'progress':
          valA = a.total > 0 ? owned_a / a.total : 0
          valB = b.total > 0 ? owned_b / b.total : 0
          break
        default: return 0
      }
      if (valA < valB) return sortOrder === 'asc' ? -1 : 1
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1
      return 0
    })

    return result
  }, [hiddenSetIdSet, progressFilter, search, series, sets, showHiddenSets, sortBy, sortOrder])

  const toggleOrder = () => setSortOrder(o => o === 'asc' ? 'desc' : 'asc')
  const appliedPanelFilters = useMemo(() => ({
    series,
    progressFilter,
    langFilter,
    showHiddenSets,
  }), [langFilter, progressFilter, series, showHiddenSets])
  const replacePanelFilters = (nextOrUpdater) => {
    const requestedFilters = typeof nextOrUpdater === 'function'
      ? nextOrUpdater(appliedPanelFilters)
      : nextOrUpdater
    const nextFilters = {
      ...requestedFilters,
      progressFilter: SET_FILTER_OPTIONS.progressFilter.has(requestedFilters.progressFilter)
        ? requestedFilters.progressFilter
        : DEFAULT_SET_FILTERS.progressFilter,
      langFilter: requestedFilters.langFilter === 'all' || visibleLanguageCodes.includes(requestedFilters.langFilter)
        ? requestedFilters.langFilter
        : defaultLangFilter,
    }
    setSeries(nextFilters.series)
    setProgressFilter(nextFilters.progressFilter)
    setLangFilter(nextFilters.langFilter)
    setShowHiddenSets(nextFilters.showHiddenSets)
    const currentParams = new URLSearchParams(window.location.search)
    const nextParams = writeFilterUrlState(currentParams, filterDefinitions, nextFilters)
    if (nextParams.toString() !== currentParams.toString()) setSearchParams(nextParams, { replace: true })
  }
  const updatePanelFilter = (key, value) => {
    replacePanelFilters(current => ({ ...current, [key]: value }))
  }
  const clearPanelFilters = () => {
    const clearedFilters = {
      series: DEFAULT_SET_FILTERS.series,
      progressFilter: DEFAULT_SET_FILTERS.progressFilter,
      langFilter: defaultLangFilter,
      showHiddenSets: DEFAULT_SET_FILTERS.showHiddenSets,
    }
    replacePanelFilters(clearedFilters)
  }
  const toggleHiddenSet = (setId) => {
    const normalizedId = String(setId)
    setHiddenSetIds(current => (
      current.includes(normalizedId)
        ? current.filter(id => id !== normalizedId)
        : [...current, normalizedId].sort()
    ))
  }
  const groups = useMemo(() => groupSetsBySeries(filtered), [filtered])
  const activeGroup = seriesKey ? groups.find(group => group.key === seriesKey) : null
  const showSeriesView = !seriesKey && view === 'series'
  const gridSets = activeGroup ? activeGroup.sets : filtered
  const activeFilterCount = [
    series !== DEFAULT_SET_FILTERS.series,
    progressFilter !== DEFAULT_SET_FILTERS.progressFilter,
    langFilter !== defaultLangFilter,
    showHiddenSets,
  ].filter(Boolean).length

  const navBar = useMemo(() => ({
    title: seriesKey ? (activeGroup?.name ?? t('nav.sets')) : t('nav.sets'),
    trailing: (
      <Menu
        label={t('ios.more')}
        sections={[
          [
            { id: 'filters', label: activeFilterCount ? `${t('cardSearch.filters')} (${activeFilterCount})` : t('cardSearch.filters'), icon: Filter, onSelect: () => setFiltersOpen(true) },
          ],
          SORT_OPTIONS.map(option => ({
            id: `sort-${option}`,
            label: t(SORT_LABEL_KEYS[option]),
            checked: sortBy === option,
            onSelect: () => setSortBy(option),
          })),
          [
            { id: 'order', label: sortOrder === 'asc' ? t('common.sortDescending') : t('common.sortAscending'), icon: sortOrder === 'asc' ? ChevronDown : ChevronUp, onSelect: toggleOrder },
          ],
        ]}
      />
    ),
  }), [activeFilterCount, activeGroup?.name, seriesKey, sortBy, sortOrder, t])
  useNavBar(navBar)

  const releaseLabelFor = (set) => {
    const d = new Date(set.release_date)
    return isNaN(d.getTime()) ? set.release_date : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  }
  const isUpcoming = (set) => {
    const d = new Date(set.release_date)
    return !isNaN(d.getTime()) && d.getTime() > Date.now()
  }

  const renderSetTile = (set) => {
    const owned = set.owned_count ?? 0
    const total = set.total ?? 0
    const isHidden = hiddenSetIdSet.has(String(set.id))
    return (
      <div
        key={set.id}
        id={`set-${set.id}`}
        data-scroll-anchor={`set-${set.id}`}
        data-testid="set-tile"
        className={clsx('relative', isHidden && 'opacity-60')}
      >
        <button type="button" className="block w-full text-left" onClick={() => openSet(set)} aria-label={set.name}>
          <SetTile
            set={{ id: set.id, name: set.name, abbreviation: set.abbreviation, logo: resolveSetImageUrl(set, 'logo'), releaseLabel: set.release_date ? releaseLabelFor(set) : '' }}
            owned={owned}
            total={total}
            upcoming={Boolean(set.release_date) && isUpcoming(set)}
            complete={total > 0 && owned >= total}
          />
        </button>
        <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1">
          {set.is_new && <span className="rounded-full bg-red px-2 py-0.5 text-caption-1 font-semibold leading-none text-white">{t('common.new')}</span>}
          {isHidden && <span className="rounded-full bg-black/70 px-2 py-0.5 text-caption-1 font-semibold leading-none text-text-secondary">{t('sets.hidden')}</span>}
        </div>
        <button
          type="button"
          onClick={() => toggleHiddenSet(set.id)}
          className="absolute right-1 top-1 grid h-9 w-9 place-items-center rounded-full bg-black/55 text-text-secondary ios-press"
          title={isHidden ? t('sets.unhideSet') : t('sets.hideSet')}
          aria-label={isHidden ? t('sets.unhideSet') : t('sets.hideSet')}
        >
          {isHidden ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    )
  }

  const skeleton = (
    <div className="grid grid-cols-2 gap-3">
      {[...Array(6)].map((_, i) => <div key={i} className="skeleton h-48 rounded-[18px]" />)}
    </div>
  )

  return (
    <div data-scroll-list="sets" className="relative isolate space-y-4 pb-2">
      <HeaderBloom colour={colourFor(seriesKey ?? 'sets')} />

      {activeGroup ? (
        <header className="flex items-center gap-4 pt-2" data-testid="series-header">
          <div className="grid h-20 w-28 flex-shrink-0 place-items-center rounded-2xl bg-black/30 p-2">
            {activeGroup.logo
              ? <img src={activeGroup.logo} alt={activeGroup.name} className="max-h-full max-w-full object-contain drop-shadow-[0_2px_6px_rgba(0,0,0,0.6)]" />
              : <span className="text-title-3 font-display text-center">{activeGroup.name}</span>}
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <h1 className="truncate text-title-2 font-display">{activeGroup.name}</h1>
            <p className="text-footnote text-text-secondary">
              {[activeGroup.years, t('ios.setsCount').replace('{count}', activeGroup.setCount)].filter(Boolean).join(' · ')}
            </p>
            <HpBar value={activeGroup.owned} max={activeGroup.total} label={activeGroup.name} />
            <p className="text-footnote tabular-nums text-text-secondary">
              {t('ios.ownedOfTotal').replace('{owned}', activeGroup.owned).replace('{total}', activeGroup.total)} {t('sets.cards')}
            </p>
          </div>
        </header>
      ) : (
        <div className="pt-1">
          <p className="text-subheadline text-text-secondary">
            {sets.length} {t('sets.setsTotal')}
            {showSeriesView && groups.length > 0 && ` · ${t('sets.seriesCount').replace('{count}', groups.length)}`}
          </p>
        </div>
      )}

      {newSets.length > 0 && !seriesKey && (
        <div className="flex items-center gap-3 rounded-2xl bg-card p-3">
          <Bell size={18} className="flex-shrink-0 text-red" />
          <div className="min-w-0 flex-1">
            <p className="text-subheadline font-medium">{newSets.length} {t('sets.newSets')} {t('sets.newSetsDetected')}</p>
            <p className="truncate text-caption-1 text-text-secondary">{newSets.map(s => s.name).join(', ')}</p>
          </div>
          <button type="button" onClick={() => markSeenMutation.mutate(newSets.map(set => set.id))} className="flex-shrink-0 px-1 text-callout text-tint ios-press">
            <BellOff size={14} className="mr-1 inline" />{t('sets.markAllSeen')}
          </button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <SearchField
          className="min-w-0 flex-1"
          value={search}
          onChange={setSearch}
          placeholder={t('sets.filterSets')}
          onCancel={() => setSearch('')}
        />
        <button
          type="button"
          onClick={() => setFiltersOpen(true)}
          className={clsx('flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full bg-fill-tertiary px-3 text-footnote font-semibold ios-press', activeFilterCount > 0 && 'text-tint')}
        >
          <Filter size={14} aria-hidden="true" />
          {t('cardSearch.filters')}{activeFilterCount > 0 && ` (${activeFilterCount})`}
        </button>
      </div>

      {isLoading || !filtersHydrated ? skeleton : showSeriesView ? (
        <div className="grid grid-cols-2 gap-3" data-testid="series-grid">
          {groups.map(group => (
            <SeriesTile
              key={group.key}
              series={{ key: group.key, name: group.name, logo: group.logo, years: group.years, setCount: group.setCount }}
              owned={group.owned}
              total={group.total}
              complete={group.complete}
              to={`/sets/series/${encodeURIComponent(group.key)}`}
            />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3" data-testid="sets-grid">
          {gridSets.map(renderSetTile)}
        </div>
      )}

      {!isLoading && filtersHydrated && (showSeriesView ? groups.length === 0 : gridSets.length === 0) && (
        <div className="py-12 text-center text-text-muted">{t('sets.noSetsFound')}</div>
      )}

      <PageSheet
        isOpen={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title={t('cardSearch.filters')}
        leading={{ label: t('common.clear'), onPress: clearPanelFilters }}
        trailing={{ label: t('ios.done'), onPress: () => setFiltersOpen(false) }}
      >
        <div className="space-y-5 px-4 pb-6">
          <div className="space-y-1.5">
            <label htmlFor="sets-filter-language" className="text-footnote text-text-secondary">{t('lang.filter')}</label>
            <TcgdexLanguageSelect
              id="sets-filter-language"
              value={langFilter}
              includeAll
              allLabel={t('lang.all')}
              compact
              languages={visibleLanguages}
              onChange={(value) => updatePanelFilter('langFilter', value)}
              className="select w-full"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="sets-filter-series" className="text-footnote text-text-secondary">{t('common.allSeries')}</label>
            <select id="sets-filter-series" aria-label={t('common.allSeries')} className="select w-full" value={series} onChange={(e) => updatePanelFilter('series', e.target.value)}>
              <option value="">{t('common.allSeries')}</option>
              {allSeries.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <p className="text-footnote text-text-secondary">{t('sets.progressLabel')}</p>
            <SegmentedControl
              ariaLabel={t('sets.progressLabel')}
              value={progressFilter}
              onChange={(value) => updatePanelFilter('progressFilter', value)}
              options={[
                { value: 'all', label: t('sets.filterAll') },
                { value: 'started', label: t('sets.filterStarted') },
                { value: 'complete', label: t('sets.filterComplete') },
              ]}
            />
          </div>
          {!seriesKey && (
            <div className="space-y-1.5">
              <p className="text-footnote text-text-secondary">{t('sets.viewLabel')}</p>
              <SegmentedControl
                ariaLabel={t('sets.viewLabel')}
                value={view}
                onChange={setView}
                options={[
                  { value: 'series', label: t('sets.viewSeries') },
                  { value: 'sets', label: t('sets.viewSets') },
                ]}
              />
            </div>
          )}
          {hiddenSetCount > 0 && (
            <button
              type="button"
              onClick={() => updatePanelFilter('showHiddenSets', !showHiddenSets)}
              className="flex w-full items-center justify-between rounded-xl bg-card px-4 py-3 text-left ios-press"
            >
              <span className="flex items-center gap-2 text-body">
                {showHiddenSets ? <EyeOff size={16} /> : <Eye size={16} />}
                {showHiddenSets ? t('sets.hideHiddenSets') : t('sets.showHiddenSets')}
              </span>
              <span className="text-footnote text-text-secondary">{hiddenSetCount}</span>
            </button>
          )}
          <p className="text-footnote text-text-secondary">{filtered.length} / {sets.length} {t('sets.setsTotal')}</p>
        </div>
      </PageSheet>
    </div>
  )
}
