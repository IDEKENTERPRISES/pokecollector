import { useState, useMemo, useEffect, useCallback } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { X, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Hash, PenLine, SlidersHorizontal, Camera, CheckSquare, Plus, ScanLine, Tags, Layers, ListOrdered } from 'lucide-react'
import toast from 'react-hot-toast'
import { searchCards, getSets, getCustomCards, bulkAddToCollection, getScanJobs, getPokedex } from '../api/client'
import { CardItem, CustomCardModal, CardModal } from '../components/CardItem'
import { useSettings } from '../contexts/SettingsContext'
import Sheet from '../components/ui/Sheet'
import { useScanner } from '../contexts/ScannerContext'
import { getDefaultVariantOrNull } from '../utils/cardVariants'
import { cardNumberMatches } from '../utils/cardNumbers'
import { normalizeSearchText, textIncludes } from '../utils/textSearch'
import { useVisibleTcgdexLanguages } from '../hooks/useVisibleTcgdexLanguages'
import TcgdexLanguageSelect from '../components/TcgdexLanguageSelect'
import { normalizeTcgdexLanguage, tcgdexLanguageLabel } from '../utils/tcgdexLanguages'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import { CardDisplay, CardLegend } from '../components/card-system'
import {
  getLastCardSearchPage,
  isValidCardSearchPage,
  parseCardSearchPage,
  updateCardSearchParams,
} from '../utils/cardSearchUrlState'
import {
  SCAN_JOBS_QUERY_KEY,
  hasActiveScanJobs,
  scanAttentionCount,
} from '../utils/scanJobs'
import { useDynamicFilterUrlState } from '../hooks/useDynamicFilterUrlState'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import PrintingDetailSelector from '../components/PrintingDetailSelector'
import HeaderBloom from '../components/ios/HeaderBloom'
import LargeTitle from '../components/ios/LargeTitle'
import SearchField from '../components/ios/SearchField'
import PageSheet from '../components/ios/PageSheet'
import Menu from '../components/ios/Menu'
import IconButton from '../components/ios/IconButton'
import PokeBall from '../components/ios/PokeBall'
import TypeChip from '../components/ios/TypeChip'
import EnergyIcon from '../components/ios/EnergyIcon'
import { tileTextFor, typeKeyFor } from '../components/ios/pokemon'
import { useNavBar } from '../navigation/useNavBar'
import { useOffline } from '../offline/useOffline'
import { groupSetsBySeries } from '../utils/setSeries'
import { getPokedexFormFamily } from '../utils/pokedexUrlState'

export const CARD_CODE_NUMBER_RE = /^([A-Za-z][A-Za-z0-9]*)\s+(\d+)$/

const TYPES = ['Fire', 'Water', 'Grass', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Dragon', 'Colorless', 'Fairy', 'Stellar']
// The eleven energy types shown in Browse by type (Stellar stays a filter-only value).
const BROWSE_TYPES = TYPES.filter(type => type !== 'Stellar')
const CATEGORIES = ['Pokemon', 'Trainer', 'Energy']
const SUBTYPES = ['Basic', 'Stage1', 'Stage2', 'Supporter', 'Item', 'Stadium', 'Tool', 'Technical Machine', 'Special']
const RARITIES = ['Common', 'Uncommon', 'Rare', 'Rare Holo', 'Rare Ultra', 'Rare Secret', 'Illustration Rare', 'Special Illustration Rare', 'Hyper Rare', 'Double Rare', 'ACE SPEC Rare', 'Promo', 'Amazing Rare']
const CARD_SEARCH_FILTER_DEFINITIONS = {
  category: { param: 'category', default: '' },
  type: { param: 'type', default: '' },
  subtype: { param: 'subtype', default: '' },
  rarity: { param: 'rarity', default: '' },
  series: { param: 'series', default: '' },
  set_id: { param: 'set_id', default: '' },
  artist: { param: 'artist', default: '' },
  rule_text: { param: 'rule_text', default: '' },
  hp_min: { param: 'hp_min', default: '' },
  hp_max: { param: 'hp_max', default: '' },
}
const CARD_SEARCH_TEXT_DEBOUNCE_MS = 300

function BrowseTile({ to, title, icon: Icon, gradient, shadow, lines, testId }) {
  return (
    <Link
      to={to}
      data-testid={testId}
      className="relative flex min-h-[116px] flex-col justify-between overflow-hidden rounded-[22px] p-4 text-white ios-press"
      style={{ background: gradient, boxShadow: `0 8px 22px color-mix(in srgb, ${shadow} 55%, transparent)` }}
    >
      <Icon size={72} strokeWidth={1.5} aria-hidden="true" className="pointer-events-none absolute -bottom-3 -right-3 opacity-20" />
      <span className="flex items-center gap-1.5 text-headline font-display"><Icon size={18} aria-hidden="true" />{title}</span>
      <span className="space-y-0.5 text-footnote tabular-nums">
        {lines.filter(Boolean).map(line => <span key={line} className="block opacity-95">{line}</span>)}
      </span>
    </Link>
  )
}

function FilterForm({ filters, setFilter, allSeries, setsForSeries, showAdvanced, setShowAdvanced, t }) {
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-text-primary">{t('common.normalFilters')}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <label htmlFor="card-search-category" className="text-xs text-text-muted mb-1 block">{t('cardSearch.cardCategory')}</label>
          <select id="card-search-category" className="select" value={filters.category} onChange={(e) => setFilter('category', e.target.value)}>
            <option value="">{t('cardSearch.allCategories')}</option>
            {CATEGORIES.map(category => <option key={category} value={category}>{category}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="card-search-energy-type" className="text-xs text-text-muted mb-1 block">{t('cardSearch.energyType')}</label>
          <select id="card-search-energy-type" className="select" value={filters.type} onChange={(e) => setFilter('type', e.target.value)}>
            <option value="">{t('cardSearch.allEnergyTypes')}</option>
            {TYPES.map(tp => <option key={tp} value={tp}>{tp}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="card-search-rarity" className="text-xs text-text-muted mb-1 block">{t('common.rarity')}</label>
          <select id="card-search-rarity" className="select" value={filters.rarity} onChange={(e) => setFilter('rarity', e.target.value)}>
            <option value="">{t('common.allRarities')}</option>
            {RARITIES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="card-search-series" className="text-xs text-text-muted mb-1 block">{t('cardSearch.series')}</label>
          <select id="card-search-series" className="select" value={filters.series} onChange={(e) => setFilter('series', e.target.value)}>
            <option value="">{t('cardSearch.allSeries')}</option>
            {allSeries.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="card-search-set" className="text-xs text-text-muted mb-1 block">{t('common.set')}</label>
          <select id="card-search-set" className="select" value={filters.set_id} onChange={(e) => setFilter('set_id', e.target.value)}>
            <option value="">{t('common.set_id_hint')}</option>
            {setsForSeries.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      </div>

      <button
        type="button"
        className="btn-ghost w-full justify-between"
        aria-expanded={showAdvanced}
        aria-controls="card-search-advanced-filters"
        onClick={() => setShowAdvanced(value => !value)}
      >
        <span>{t('common.advancedFilters')}</span>
        <ChevronDown size={16} className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
      </button>

      {showAdvanced && (
        <div id="card-search-advanced-filters" className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-xl border border-border p-3">
          <div>
            <label htmlFor="card-search-subtype" className="text-xs text-text-muted mb-1 block">{t('cardSearch.subtype')}</label>
            <select id="card-search-subtype" className="select" value={filters.subtype} onChange={(e) => setFilter('subtype', e.target.value)}>
              <option value="">{t('cardSearch.allSubtypes')}</option>
              {SUBTYPES.map(subtype => <option key={subtype} value={subtype}>{subtype}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="card-search-artist" className="text-xs text-text-muted mb-1 block">{t('cardSearch.artist')}</label>
            <input id="card-search-artist" type="text" value={filters.artist}
              onChange={(e) => setFilter('artist', e.target.value)} className="input text-sm" />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="card-search-rule-text" className="text-xs text-text-muted mb-1 block">{t('cardSearch.ruleText')}</label>
            <input id="card-search-rule-text" type="text" value={filters.rule_text}
              onChange={(e) => setFilter('rule_text', e.target.value)} className="input text-sm" />
          </div>
          <div>
            <label htmlFor="card-search-hp-min" className="text-xs text-text-muted mb-1 block">{t('cardSearch.hpMin')}</label>
            <input id="card-search-hp-min" type="number" min="0" max="999" placeholder="0" value={filters.hp_min}
              onChange={(e) => setFilter('hp_min', e.target.value)} className="input text-sm" />
          </div>
          <div>
            <label htmlFor="card-search-hp-max" className="text-xs text-text-muted mb-1 block">{t('cardSearch.hpMax')}</label>
            <input id="card-search-hp-max" type="number" min="0" max="999" placeholder="999" value={filters.hp_max}
              onChange={(e) => setFilter('hp_max', e.target.value)} className="input text-sm" />
          </div>
        </div>
      )}
    </div>
  )
}

export function buildCardSearchParams(filters, langFilter, page, pageSize) {
  return {
    q: filters.name || undefined,
    category: filters.category || undefined,
    type: filters.type || undefined,
    subtype: filters.subtype || undefined,
    rarity: filters.rarity || undefined,
    set_id: filters.set_id || undefined,
    artist: filters.artist || undefined,
    rule_text: filters.rule_text.trim() || undefined,
    hp_min: filters.hp_min ? parseInt(filters.hp_min, 10) : undefined,
    hp_max: filters.hp_max ? parseInt(filters.hp_max, 10) : undefined,
    sort_by: filters.sort_by || undefined,
    sort_order: filters.sort_order,
    lang: langFilter,
    page,
    page_size: pageSize,
  }
}

export default function CardSearch() {
  const { t, settings, formatPrice } = useSettings()
  const visibleLanguages = useVisibleTcgdexLanguages()
  const queryClient = useQueryClient()
  const location = useLocation()
  const navigate = useNavigate()
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search])
  const [searchInput, setSearchInput] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false)
  const [showCustomModal, setShowCustomModal] = useState(false)
  const { openScanner } = useScanner()
  const [selectedCard, setSelectedCard] = useState(null)
  const [selectedCardTab, setSelectedCardTab] = useState('add')
  const [selectMode, setSelectMode] = useState(false)
  const [selectedItems, setSelectedItems] = useState(new Map()) // card.id -> { card_id, lang }
  const [bulkPrintingDetails, setBulkPrintingDetails] = useState([])
  const [showBulkPrintingDetails, setShowBulkPrintingDetails] = useState(false)
  const pageSize = 20

  const { data: recentCustomCards = [] } = useQuery({
    queryKey: ['custom-cards'],
    queryFn: () => getCustomCards().then(r => r.data),
  })

  const { data: scanData } = useQuery({
    queryKey: SCAN_JOBS_QUERY_KEY,
    queryFn: getScanJobs,
    refetchInterval: query => hasActiveScanJobs(query.state.data?.jobs || []) ? 3000 : false,
  })
  const scanJobs = scanData?.jobs || []
  const scanAttention = scanAttentionCount(scanJobs)
  const scansActive = hasActiveScanJobs(scanJobs)

  const { data: allSets = [] } = useQuery({
    queryKey: ['sets', settings.language || 'en'],
    queryFn: () => getSets().then(r => r.data),
    staleTime: 5 * 60 * 1000,
  })

  const allSeries = useMemo(() => [...new Set(allSets.map(s => s.series).filter(Boolean))].sort(), [allSets])
  const visibleLanguageCodes = useMemo(() => visibleLanguages.map(language => language.code), [visibleLanguages])
  const preferredCatalogueLanguage = normalizeTcgdexLanguage(settings.language || 'en', 'en')
  const defaultLangFilter = visibleLanguageCodes.includes(preferredCatalogueLanguage)
    ? preferredCatalogueLanguage
    : 'all'

  // Search state is deliberately derived from the URL. This makes direct links,
  // refreshes, and browser history reproduce precisely the same search.
  const { filters, langFilter, page } = useMemo(() => {
    const read = (key) => {
      const value = searchParams.get(key)
      return key === 'rule_text' ? value || '' : value?.trim() || ''
    }
    const enumValue = (key, values) => {
      const value = read(key)
      return values.includes(value) ? value : ''
    }
    const hpValue = (key) => {
      const value = read(key)
      return /^\d+$/.test(value) && Number(value) <= 999 ? value : ''
    }
    const selectedSeries = read('series')
    const selectedSet = read('set_id')
    const setIsValid = !selectedSet || !selectedSeries || !allSets.length || allSets.some((set) => set.id === selectedSet && set.series === selectedSeries)
    const requestedLanguage = read('lang')
    const language = requestedLanguage === 'all'
      ? 'all'
      : requestedLanguage && visibleLanguageCodes.includes(normalizeTcgdexLanguage(requestedLanguage, ''))
        ? normalizeTcgdexLanguage(requestedLanguage, '')
        : defaultLangFilter
    return {
      filters: {
        name: read('q'),
        category: enumValue('category', CATEGORIES),
        type: enumValue('type', TYPES),
        subtype: enumValue('subtype', SUBTYPES),
        rarity: enumValue('rarity', RARITIES),
        series: selectedSeries,
        set_id: setIsValid ? selectedSet : '',
        artist: read('artist'),
        rule_text: read('rule_text'),
        hp_min: hpValue('hp_min'),
        hp_max: hpValue('hp_max'),
        sort_by: enumValue('sort_by', ['name', 'number', 'rarity']),
        sort_order: read('sort_order') === 'desc' ? 'desc' : 'asc',
      },
      langFilter: language,
      page: parseCardSearchPage(read('page')),
    }
  }, [allSets, defaultLangFilter, searchParams, visibleLanguageCodes])

  const normalizePanelFilters = useCallback((state) => {
    const hpValue = (value) => /^\d+$/.test(value) && Number(value) <= 999 ? value : ''
    const setIsValid = !state.set_id || !state.series || !allSets.length || allSets.some(
      set => set.id === state.set_id && set.series === state.series,
    )
    return {
      ...state,
      category: CATEGORIES.includes(state.category) ? state.category : '',
      type: TYPES.includes(state.type) ? state.type : '',
      subtype: SUBTYPES.includes(state.subtype) ? state.subtype : '',
      rarity: RARITIES.includes(state.rarity) ? state.rarity : '',
      set_id: setIsValid ? state.set_id : '',
      hp_min: state.hp_min ? hpValue(state.hp_min) : '',
      hp_max: state.hp_max ? hpValue(state.hp_max) : '',
    }
  }, [allSets])
  const {
    filters: dynamicFilters,
    updateFilter: updateDynamicFilter,
    replaceFilters: replaceDynamicFilters,
    clearFilters: clearDynamicFilters,
  } = useDynamicFilterUrlState(CARD_SEARCH_FILTER_DEFINITIONS, {
    normalizeState: normalizePanelFilters,
    resetParams: ['page'],
  })
  const setsForSeries = useMemo(() => {
    if (!dynamicFilters.series) return allSets
    return allSets.filter(set => set.series === dynamicFilters.series)
  }, [allSets, dynamicFilters.series])

  const updateSearchParams = useCallback((updates, { replace = false, resetPage = true } = {}) => {
    const next = updateCardSearchParams(location.search, updates, { resetPage })
    const search = next.toString()
    if (search === searchParams.toString()) return
    navigate(
      { pathname: location.pathname, search: search ? `?${search}` : '' },
      { replace },
    )
  }, [location.pathname, location.search, navigate, searchParams])

  const debouncedArtist = useDebouncedValue(dynamicFilters.artist, CARD_SEARCH_TEXT_DEBOUNCE_MS)
  const debouncedRuleText = useDebouncedValue(dynamicFilters.rule_text, CARD_SEARCH_TEXT_DEBOUNCE_MS)
  const debouncedHpMin = useDebouncedValue(dynamicFilters.hp_min, CARD_SEARCH_TEXT_DEBOUNCE_MS)
  const debouncedHpMax = useDebouncedValue(dynamicFilters.hp_max, CARD_SEARCH_TEXT_DEBOUNCE_MS)
  const queryFilters = {
    ...filters,
    ...dynamicFilters,
    artist: debouncedArtist,
    rule_text: debouncedRuleText,
    hp_min: debouncedHpMin,
    hp_max: debouncedHpMax,
  }
  const queryParams = buildCardSearchParams(queryFilters, langFilter, page, pageSize)

  const hasQuery = filters.name || queryFilters.category || queryFilters.type || queryFilters.subtype || queryFilters.rarity || queryFilters.set_id || queryFilters.artist || queryFilters.rule_text.trim() || queryFilters.hp_min || queryFilters.hp_max || queryFilters.series

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['card-search', queryParams],
    queryFn: () => searchCards(queryParams).then(r => r.data),
    enabled: !!hasQuery,
    placeholderData: (prev) => prev,
  })

  const totalPages = data ? getLastCardSearchPage(data.total_count, pageSize) : 0
  const hasUrlSearchState = Array.from(searchParams.keys()).length > 0
  const hasActiveFilters = Boolean(
    dynamicFilters.category || dynamicFilters.type || dynamicFilters.subtype || dynamicFilters.rarity ||
    dynamicFilters.set_id || dynamicFilters.series || dynamicFilters.artist || dynamicFilters.rule_text.trim() || dynamicFilters.hp_min ||
    dynamicFilters.hp_max
  )
  const activeFilterCount = [
    dynamicFilters.category, dynamicFilters.type, dynamicFilters.subtype, dynamicFilters.rarity,
    dynamicFilters.set_id, dynamicFilters.series, dynamicFilters.artist, dynamicFilters.rule_text.trim(), dynamicFilters.hp_min,
    dynamicFilters.hp_max,
  ].filter(Boolean).length
  const isCodeNumberSearch = CARD_CODE_NUMBER_RE.test(searchInput.trim())

  const handleSearch = (e) => {
    e.preventDefault()
    updateSearchParams({ q: searchInput })
  }

  const setDynamicFilter = (key, value) => {
    if (key === 'series') {
      replaceDynamicFilters(current => {
        const next = { ...current, [key]: value }
        const setStillValid = !value || allSets.some(set => set.id === current.set_id && set.series === value)
        if (!setStillValid) next.set_id = ''
        return next
      })
      return
    }
    updateDynamicFilter(key, value)
  }

  const openFilters = () => {
    setShowAdvancedFilters(Boolean(dynamicFilters.subtype || dynamicFilters.artist || dynamicFilters.rule_text.trim() || dynamicFilters.hp_min || dynamicFilters.hp_max))
    setShowFilters(true)
  }

  const clearFilters = () => {
    clearDynamicFilters()
    setShowAdvancedFilters(false)
  }

  const clearSearch = () => navigate({ pathname: location.pathname, search: '' })

  const hasOpenOverlay = Boolean(selectedCard || showFilters || showCustomModal)

  useEffect(() => {
    setSearchInput(filters.name)
  }, [filters.name])

  useEffect(() => {
    // Browser history can move away and back before React commits the
    // intermediate location. Read the URL at the popstate boundary so the
    // editable draft never remains attached to a different search entry.
    const syncSearchInputFromHistory = () => {
      setSearchInput(new URLSearchParams(window.location.search).get('q')?.trim() || '')
    }
    window.addEventListener('popstate', syncSearchInputFromHistory)
    return () => window.removeEventListener('popstate', syncSearchInputFromHistory)
  }, [])

  useEffect(() => {
    const rawPage = searchParams.get('page')
    if (!rawPage || isValidCardSearchPage(rawPage)) return
    updateSearchParams({ page: '' }, { replace: true, resetPage: false })
  }, [searchParams, updateSearchParams])

  useEffect(() => {
    if (!data || isFetching || page <= totalPages) return
    updateSearchParams(
      { page: totalPages > 1 ? totalPages : '' },
      { replace: true, resetPage: false },
    )
  }, [data, isFetching, page, totalPages, updateSearchParams])

  useEffect(() => {
    // Once set data is available, remove a set that does not belong to its URL series.
    if (!allSets.length || !filters.series || !searchParams.get('set_id') || filters.set_id) return
    updateSearchParams({ set_id: '' }, { replace: true, resetPage: false })
  }, [allSets.length, filters.series, filters.set_id, searchParams, updateSearchParams])

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.defaultPrevented || hasOpenOverlay || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return

      const target = event.target
      const tagName = target?.tagName?.toLowerCase?.()
      if (tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target?.isContentEditable) {
        return
      }

      if (event.key === 'ArrowLeft' && page > 1) {
        updateSearchParams({ page: Math.max(1, page - 1) }, { resetPage: false })
        event.preventDefault()
      }
      if (event.key === 'ArrowRight' && totalPages > 0 && page < totalPages) {
        updateSearchParams({ page: Math.min(totalPages, page + 1) }, { resetPage: false })
        event.preventDefault()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [hasOpenOverlay, page, totalPages, updateSearchParams])

  const handleCustomCreated = () => {
    queryClient.invalidateQueries({ queryKey: ['custom-cards'] })
  }

  const matchedCustomCards = useMemo(() => {
    const searchTerm = filters.name.trim()
    if (!searchTerm) return []

    const normalizedSearchTerm = normalizeSearchText(searchTerm)
    const codeMatch = CARD_CODE_NUMBER_RE.exec(searchTerm)

    return recentCustomCards.filter((card) => {
      if (textIncludes(card.name, normalizedSearchTerm)) {
        return true
      }

      if (!codeMatch) {
        return false
      }

      const [, rawSetCode, rawNumber] = codeMatch
      const normalizedSetCode = normalizeSearchText(rawSetCode)
      const normalizedNumber = String(parseInt(rawNumber, 10))
      const matchingSet = allSets.find((set) => (
        normalizeSearchText(set.tcg_set_id) === normalizeSearchText(card.set_id) ||
        normalizeSearchText(set.id) === normalizeSearchText(card.set_id)
      ))
      const setMatches = [
        card.set_id,
        matchingSet?.abbreviation,
        matchingSet?.tcg_set_id,
        matchingSet?.id,
      ].some((value) => normalizeSearchText(value) === normalizedSetCode)
      return setMatches && cardNumberMatches(card.number, normalizedNumber)
    })
  }, [allSets, filters.name, recentCustomCards])

  const filterFormProps = {
    filters: dynamicFilters,
    setFilter: setDynamicFilter,
    allSeries,
    setsForSeries,
    showAdvanced: showAdvancedFilters,
    setShowAdvanced: setShowAdvancedFilters,
    t,
  }

  const cardLang = (card) => card._lang || card.lang || (langFilter === 'all' ? 'en' : langFilter)

  const toggleSelected = (card) => {
    setSelectedItems(prev => {
      const next = new Map(prev)
      if (next.has(card.id)) next.delete(card.id)
      else next.set(card.id, { card_id: card.id, lang: cardLang(card), variant: getDefaultVariantOrNull(card) })
      return next
    })
  }

  const selectAllOnPage = () => {
    setSelectedItems(prev => {
      const next = new Map(prev)
      for (const card of (data?.data || [])) {
        next.set(card.id, { card_id: card.id, lang: cardLang(card), variant: getDefaultVariantOrNull(card) })
      }
      return next
    })
  }

  const clearSelection = () => setSelectedItems(new Map())

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedItems(new Map())
    setBulkPrintingDetails([])
    setShowBulkPrintingDetails(false)
  }

  const selectAllMatchingMutation = useMutation({
    mutationFn: async () => {
      const total = data?.total_count || 0
      if (total === 0) return []
      const r = await searchCards({ ...queryParams, page: 1, page_size: total })
      return r.data?.data || []
    },
    onSuccess: (cards) => {
      setSelectedItems(prev => {
        const next = new Map(prev)
        for (const card of cards) {
          next.set(card.id, { card_id: card.id, lang: cardLang(card), variant: getDefaultVariantOrNull(card) })
        }
        return next
      })
    },
    onError: () => toast.error(t('cardSearch.searchFailed')),
  })

  const bulkAddMutation = useMutation({
    mutationFn: () => {
      const items = Array.from(selectedItems.values()).map(({ card_id, lang, variant }) => ({
        card_id,
        quantity: 1,
        condition: 'NM',
        variant,
        purchase_price: null,
        lang,
        printing_details: bulkPrintingDetails,
      }))
      return bulkAddToCollection(items)
    },
    onSuccess: (result) => {
      const parts = [
        `${result.added} ${t('cardSearch.bulkAddedNew')}`,
        `${result.updated} ${t('cardSearch.bulkAddedExisting')}`,
      ]
      if (result.failed > 0) parts.push(`${result.failed} ${t('cardSearch.bulkAddFailedCount')}`)
      toast.success(parts.join(' · '))
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      exitSelectMode()
    },
    onError: () => toast.error(t('cardSearch.bulkAddFailed')),
  })

  const isOffline = useOffline()
  const pokedexLanguage = settings.language === 'de' ? 'de' : 'en'
  const defaultFormFamily = getPokedexFormFamily(new URLSearchParams())
  // Same key and request as the Pokédex page, so the count comes from the same cache entry.
  const { data: pokedexData } = useQuery({
    queryKey: ['pokedex', null, 'grouped', defaultFormFamily, 'all', '', pokedexLanguage],
    queryFn: () => getPokedex({ status: 'all', lang: pokedexLanguage, mode: 'grouped', form_family: defaultFormFamily }),
    staleTime: 60_000,
    enabled: !hasQuery,
  })
  const pokedexSummary = pokedexData?.summary
  const seriesGroups = useMemo(() => groupSetsBySeries(allSets), [allSets])
  const newSetCount = useMemo(() => allSets.filter(set => set.is_new).length, [allSets])

  const typesInResults = useMemo(() => {
    const seen = []
    for (const card of data?.data || []) {
      for (const type of card.types || []) {
        if (BROWSE_TYPES.includes(type) && !seen.includes(type)) seen.push(type)
      }
    }
    if (dynamicFilters.type && BROWSE_TYPES.includes(dynamicFilters.type) && !seen.includes(dynamicFilters.type)) seen.push(dynamicFilters.type)
    return seen
  }, [data, dynamicFilters.type])

  const navBar = useMemo(() => ({
    trailing: (
      <>
        <IconButton icon={Camera} label={t('scanner.title')} onClick={openScanner} />
        <Menu
          label={t('ios.more')}
          sections={[
            [
              ...(hasQuery ? [{
                id: 'select',
                label: selectMode ? t('cardSearch.exitSelect') : t('cardSearch.select'),
                icon: CheckSquare,
                onSelect: () => (selectMode ? exitSelectMode() : setSelectMode(true)),
              }] : []),
              { id: 'custom', label: t('cardSearch.createCustomCard'), icon: PenLine, onSelect: () => setShowCustomModal(true) },
              { id: 'queue', label: scanAttention > 0 ? `${t('scanner.queueTitle')} (${scanAttention})` : t('scanner.queueTitle'), icon: ScanLine, onSelect: () => navigate('/scans') },
            ],
            ...(hasUrlSearchState ? [[{ id: 'clear', label: t('common.clear'), icon: X, onSelect: clearSearch }]] : []),
          ]}
        />
      </>
    ),
  // The handlers close over state that is already in this list or is stable per render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [hasQuery, hasUrlSearchState, openScanner, scanAttention, selectMode, t])
  useNavBar(navBar)

  const submitSearch = (value) => updateSearchParams({ q: value })
  const cancelSearch = () => {
    setSearchInput('')
    updateSearchParams({ q: '' }, { replace: true })
  }
  const sortOptions = [
    { value: '', label: '—' },
    { value: 'name', label: t('cardSearch.sortName') },
    { value: 'number', label: t('cardSearch.sortNumber') },
    { value: 'rarity', label: t('cardSearch.sortRarity') },
  ]

  return (
    <div className="relative isolate space-y-4 pb-2">
      <HeaderBloom variant="search" />
      <LargeTitle title={t('nav.search')} />

      <div
        className="sticky z-20 -mx-4 bg-bg/90 px-4 py-2 backdrop-blur"
        style={{ top: 'calc(var(--safe-top, 0px) + var(--navbar-height, 44px))' }}
      >
        <SearchField
          value={searchInput}
          onChange={setSearchInput}
          onSubmit={submitSearch}
          onCancel={cancelSearch}
          disabled={isOffline}
          placeholder={isOffline ? t('cardSearch.needsConnection') : t('cardSearch.searchFieldPlaceholder')}
        />
        {isCodeNumberSearch && !isOffline && (
          <p className="mt-1 flex items-center gap-1 px-1 text-caption-1 text-yellow">
            <Hash size={12} aria-hidden="true" />{t('cardSearch.setCodeSearch')}
          </p>
        )}
      </div>

      {/* ─── Browse (no query) ───────────────────────────────────── */}
      {!hasQuery && (
        <div className="space-y-5" data-testid="search-browse">
          <div className="grid grid-cols-2 gap-3">
            <BrowseTile
              to="/sets"
              testId="browse-sets"
              title={t('nav.sets')}
              icon={Layers}
              gradient="linear-gradient(150deg, var(--type-water-top), var(--type-water-bottom))"
              shadow="var(--type-water)"
              lines={[
                newSetCount > 0 ? t('cardSearch.newSets').replace('{count}', newSetCount) : null,
                allSets.length > 0
                  ? t('cardSearch.seriesAndSets').replace('{series}', seriesGroups.length).replace('{sets}', allSets.length)
                  : null,
              ]}
            />
            <BrowseTile
              to="/pokedex"
              testId="browse-pokedex"
              title={t('nav.pokedex')}
              icon={ListOrdered}
              gradient="linear-gradient(150deg, #E3350D, #8A1D12)"
              shadow="#E3350D"
              lines={[
                pokedexSummary?.total
                  ? t('cardSearch.caughtOf').replace('{owned}', pokedexSummary.owned.toLocaleString()).replace('{total}', pokedexSummary.total.toLocaleString())
                  : null,
              ]}
            />
          </div>

          <button
            type="button"
            onClick={openScanner}
            data-testid="browse-scan"
            className="flex w-full items-center gap-4 rounded-[22px] bg-card p-4 text-left ios-press"
          >
            <PokeBall size={44} gloss />
            <span className="min-w-0 flex-1">
              <span className="block text-headline font-display">{t('cardSearch.scanInstead')}</span>
              <span className="block text-footnote text-text-secondary">{t('cardSearch.scanInsteadHint')}</span>
            </span>
            <ChevronRight size={18} className="text-text-muted" aria-hidden="true" />
          </button>

          <section aria-labelledby="browse-by-type">
            <h2 id="browse-by-type" className="mb-2 px-1 text-title-3 font-display">{t('cardSearch.browseByType')}</h2>
            <div className="grid grid-cols-3 gap-2">
              {BROWSE_TYPES.map(type => {
                const key = typeKeyFor(type)
                return (
                  <Link
                    key={type}
                    to={{ pathname: '/search', search: `?type=${encodeURIComponent(type)}` }}
                    data-testid={`browse-type-${key}`}
                    className="relative flex h-20 flex-col justify-between overflow-hidden rounded-[18px] p-3 ios-press"
                    style={{
                      background: `linear-gradient(150deg, var(--type-${key}-top), var(--type-${key}-bottom))`,
                      color: tileTextFor(key),
                    }}
                  >
                    <EnergyIcon type={key} size={24} />
                    <span className="text-footnote font-semibold font-display">{type}</span>
                  </Link>
                )
              })}
            </div>
          </section>
        </div>
      )}

      {/* ─── Results toolbar (query) ─────────────────────────────── */}
      {hasQuery && (
        <div className="flex items-center gap-2" data-testid="search-toolbar">
          <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {typesInResults.length > 0 && (
              <TypeChip
                type="all"
                selected={!dynamicFilters.type}
                onPress={() => setDynamicFilter('type', '')}
              />
            )}
            {typesInResults.map(type => (
              <TypeChip
                key={type}
                type={type}
                selected={dynamicFilters.type === type}
                onPress={() => setDynamicFilter('type', dynamicFilters.type === type ? '' : type)}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={openFilters}
            aria-label={t('cardSearch.filters')}
            className={`flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full bg-fill-tertiary px-3 text-footnote font-semibold ios-press ${hasActiveFilters ? 'text-tint' : ''}`}
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            {hasActiveFilters ? `${t('cardSearch.filters')} (${activeFilterCount})` : t('cardSearch.filters')}
          </button>
        </div>
      )}

      {/* ─── Filters ─────────────────────────────────────────────── */}
      <PageSheet
        isOpen={showFilters}
        onClose={() => setShowFilters(false)}
        title={t('cardSearch.filters')}
        leading={{ label: t('common.clear'), onPress: clearFilters }}
        trailing={{ label: t('ios.done'), onPress: () => setShowFilters(false) }}
      >
        <div className="space-y-4 px-4 pb-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-text-muted">{t('lang.filter')}:</span>
            <TcgdexLanguageSelect
              value={langFilter}
              includeAll
              allLabel={t('lang.all')}
              compact
              languages={visibleLanguages}
              onChange={(value) => updateSearchParams({ lang: value === defaultLangFilter ? '' : value })}
              className="select w-full text-xs py-1.5 sm:w-52"
            />
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="card-search-sort-by" className="text-xs text-text-muted">{t('cardSearch.sortBy')}</label>
            <select
              id="card-search-sort-by"
              aria-label={t('cardSearch.sortBy')}
              className="select w-36 py-1.5 text-sm"
              value={filters.sort_by}
              onChange={(event) => updateSearchParams({
                sort_by: event.target.value,
                sort_order: event.target.value ? filters.sort_order : '',
              })}
            >
              {sortOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {filters.sort_by && (
              <button
                type="button"
                onClick={() => updateSearchParams({ sort_order: filters.sort_order === 'asc' ? 'desc' : 'asc' })}
                className="btn-ghost px-2 py-1.5 text-sm"
                aria-label={filters.sort_order === 'asc' ? t('common.sortDescending') : t('common.sortAscending')}
              >
                {filters.sort_order === 'asc' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>
            )}
          </div>
          <FilterForm {...filterFormProps} />
        </div>
      </PageSheet>

      {(matchedCustomCards.length > 0 || (data?.data || []).length > 0) && (
        <CardLegend
          legendProps={{ showSelection: true }}
        />
      )}

      {isLoading && hasQuery && (
        <div className="grid grid-cols-2 gap-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="card p-0">
              <div className="skeleton aspect-[2.5/3.5] rounded-xl mb-3" />
              <div className="p-3 space-y-2">
                <div className="skeleton h-4 rounded w-3/4" />
                <div className="skeleton h-3 rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      )}

      {error && hasQuery && (
        <div className="card text-center py-8">
          <p className="text-brand-red">{t('cardSearch.searchFailed')}</p>
        </div>
      )}

      {matchedCustomCards.length > 0 && filters.name.trim() && (
        <div>
          <p className="text-xs text-yellow font-medium mb-2 flex items-center gap-1">
            <PenLine size={12} /> {t('cardSearch.customCard')}
          </p>
          <div className="grid grid-cols-2 gap-3">
            {matchedCustomCards.map((card) => (
              <CardItem key={card.id} card={card} />
            ))}
          </div>
        </div>
      )}

      {data && !isLoading && hasQuery && (
        <>
          {selectMode && (
            <div className="card sticky top-2 z-20 hidden flex-wrap items-center gap-2 bg-bg-elevated/95 backdrop-blur sm:flex">
              <span className="text-sm font-semibold text-brand-red">
                {selectedItems.size} {t('cardSearch.selected')}
              </span>
              <div className="flex-1" />
              <button
                onClick={selectAllOnPage}
                disabled={!data.data?.length}
                className="btn-ghost text-sm disabled:opacity-50"
              >
                {t('cardSearch.selectPage')}
              </button>
              <button
                onClick={() => selectAllMatchingMutation.mutate()}
                disabled={!data.total_count || selectAllMatchingMutation.isPending}
                className="btn-ghost text-sm disabled:opacity-50"
              >
                {selectAllMatchingMutation.isPending
                  ? t('cardSearch.bulkAddLoading')
                  : `${t('cardSearch.selectAllMatching')} (${data.total_count?.toLocaleString()})`}
              </button>
              <button
                onClick={clearSelection}
                disabled={selectedItems.size === 0}
                className="btn-ghost text-sm disabled:opacity-50"
              >
                <X size={14} /> {t('cardSearch.clearSelection')}
              </button>
              <button
                type="button"
                onClick={() => setShowBulkPrintingDetails(true)}
                className="btn-ghost px-3 text-sm"
                title={t('printingDetails.label')}
              >
                <Tags size={14} /> {bulkPrintingDetails.length || ''}
              </button>
              <button
                onClick={() => bulkAddMutation.mutate()}
                disabled={selectedItems.size === 0 || bulkAddMutation.isPending}
                className="btn-primary text-sm disabled:opacity-50"
              >
                <Plus size={14} />
                {bulkAddMutation.isPending ? t('card.adding') : t('cardSearch.addSelected')}
              </button>
            </div>
          )}
          {selectMode && (
            <div className="fixed bottom-24 left-3 right-3 z-40 flex items-center gap-2 rounded-2xl border border-white/15 bg-bg-surface/95 p-3 shadow-2xl backdrop-blur sm:hidden">
              <span className="min-w-0 flex-1 text-sm font-semibold text-brand-red">
                {selectedItems.size} {t('cardSearch.selected')}
              </span>
              <button
                type="button"
                onClick={() => setShowBulkPrintingDetails(true)}
                className="btn-ghost px-3"
                aria-label={t('printingDetails.label')}
              >
                <Tags size={15} />{bulkPrintingDetails.length > 0 && <span>{bulkPrintingDetails.length}</span>}
              </button>
              <button
                type="button"
                onClick={clearSelection}
                disabled={selectedItems.size === 0}
                className="btn-ghost px-3 disabled:opacity-50"
                aria-label={t('cardSearch.clearSelection')}
              >
                <X size={15} />
              </button>
              <button
                type="button"
                onClick={() => bulkAddMutation.mutate()}
                disabled={selectedItems.size === 0 || bulkAddMutation.isPending}
                className="btn-primary justify-center px-3 text-sm disabled:opacity-50"
              >
                <Plus size={14} />
                {bulkAddMutation.isPending ? t('card.adding') : t('cardSearch.addSelected')}
              </button>
            </div>
          )}

          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-sm text-text-secondary">
              {data.total_count?.toLocaleString()} {t('cardSearch.results')}
              {isFetching && <span className="ml-2 text-text-muted">{t('common.updating')}</span>}
            </p>
            {totalPages > 1 && (
              <div className="flex items-center gap-2">
                <button onClick={() => updateSearchParams({ page: Math.max(1, page - 1) }, { resetPage: false })} disabled={page <= 1} className="btn-ghost py-1.5 px-2 disabled:opacity-50" aria-label={t('pokedex.previous')}>
                  <ChevronLeft size={16} />
                </button>
                <span className="text-sm text-text-secondary">{page} / {totalPages}</span>
                <button onClick={() => updateSearchParams({ page: Math.min(totalPages, page + 1) }, { resetPage: false })} disabled={page >= totalPages} className="btn-ghost py-1.5 px-2 disabled:opacity-50" aria-label={t('pokedex.next')}>
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </div>

          {data.data?.length === 0 ? (
            <div className="space-y-4 py-12 text-center" data-testid="search-no-results">
              <p className="text-text-muted">{t('cardSearch.noCardsFound')}</p>
              <div className="flex flex-col items-center gap-2">
                <button onClick={openScanner} className="btn-ghost mx-auto">
                  <PokeBall size={16} /> {t('cardSearch.scanInstead')}
                </button>
                <button onClick={() => setShowCustomModal(true)} className="btn-ghost border-yellow/30 text-yellow hover:bg-yellow/10 mx-auto">
                  <PenLine size={14} /> {t('cardSearch.cardNotFound')}
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {data.data?.map((card) => {
                const imgSrc = card.images?.small || card.images_small || (card.image ? `${card.image}/low.webp` : null)
                const isSelected = selectedItems.has(card.id)
                const cardPrice = card.price_market ?? card.price_trend ?? null
                return (
                  <CardDisplay
                    key={card.id}
                    card={card}
                    image={imgSrc}
                    price={cardPrice > 0 ? formatPrice(cardPrice) : null}
                    languageLabel={card._lang && langFilter === 'all' ? tcgdexLanguageLabel(card._lang) : null}
                    selected={selectMode && isSelected}
                    onSelect={selectMode ? () => toggleSelected(card) : undefined}
                    onClick={() => {
                      if (selectMode) toggleSelected(card)
                      else {
                        setSelectedCardTab('add')
                        setSelectedCard(card)
                      }
                    }}
                    onAdd={!selectMode ? () => {
                      setSelectedCardTab('add')
                      setSelectedCard(card)
                    } : undefined}
                  />
                )
              })}
            </div>
          )}
        </>
      )}

      {showCustomModal && (
        <CustomCardModal
          onClose={() => setShowCustomModal(false)}
          onCreated={handleCustomCreated}
          sets={allSets}
          autoAddCollection={false}
        />
      )}

      {selectedCard && (
        <CardModal
          card={selectedCard}
          onClose={() => setSelectedCard(null)}
          defaultLang={selectedCard._lang || (langFilter === 'all' ? 'en' : langFilter)}
          ownedItems={selectedCard.owned_items || []}
          initialTab={selectedCardTab}
        />
      )}

      <Sheet isOpen={showBulkPrintingDetails} onClose={() => setShowBulkPrintingDetails(false)} title={t('printingDetails.label')}>
        <div className="space-y-4 p-4">
          <p className="text-sm text-text-secondary">{t('printingDetails.bulkHelp')}</p>
          <PrintingDetailSelector value={bulkPrintingDetails} onChange={setBulkPrintingDetails} />
          <button type="button" className="btn-primary w-full justify-center" onClick={() => setShowBulkPrintingDetails(false)}>{t('common.close')}</button>
        </div>
      </Sheet>

    </div>
  )
}
