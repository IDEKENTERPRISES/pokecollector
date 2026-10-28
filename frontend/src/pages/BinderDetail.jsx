import { useState, useMemo, useRef, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavBar } from '../navigation/useNavBar'
import HpBar from '../components/ios/HpBar'
import IconButton from '../components/ios/IconButton'
import Menu from '../components/ios/Menu'
import PageSheet from '../components/ios/PageSheet'
import { MoreHorizontal, Sparkles, Plus, Minus, Trash2, Package, Star, Download, Upload, X, Heart, HelpCircle, BookOpen, Grid2X2 } from 'lucide-react'
import { getBinderCards, removeCardFromBinder, removeBinderEntry, addCardToBinder, addCollectionItemToBinder, getCollection, updateBinderEntry, getBinderEntryEquivalentPrints, getBinderPrintOptimization, applyBinderPrintOptimization, switchBinderEntryCard, addBinderEntryToWishlist, addBinderCardsToWishlist, convertWishlistBinderToCollection, convertCollectionBinderToWishlist, importBinderCsv, exportBinderCsv, getApiErrorMessage, getBinderSlots, replaceBinderSlots, compactBinderSlots, updateBinder } from '../api/client'
import { isOffline } from '../offline/offlineStatus'
import { useSettings } from '../contexts/SettingsContext'
import toast from 'react-hot-toast'
import { hasCatalogueImage, resolveCardImageUrl } from '../utils/imageUrl'
import { normalizeSearchText, textIncludes } from '../utils/textSearch'
import { tcgdexLanguageLabel } from '../utils/tcgdexLanguages'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import { BINDER_SORT_OPTIONS, sortBinderCards } from '../utils/binderCards'
import { partitionSettledResults } from '../utils/settledResults'
import { formatBinderCountSummary } from '../utils/binderCounts'
import { binderPickerItemsWithQuantities, binderPickerQuantitiesAreValid, canConvertWishlistBinder } from '../utils/binderQuantity'
import { CardDialog, CardDisplay, CardLegend } from '../components/card-system'
import { CollectionCardDisplay, OwnPhotoOverlayBadge, showsOwnPhoto, useCollectionPhotoUrl } from '../components/CollectionCardImage'
import Modal from '../components/ui/Modal'
import BinderCsvImportModal, { downloadBinderCsvTemplate } from '../components/binders/BinderCsvImportModal'
import CardSelectionQuantityModal from '../components/card-system/CardSelectionQuantityModal'
import CardListPicker from '../components/card-lists/CardListPicker'
import CardListGallery from '../components/card-lists/CardListGallery'
import BookView from '../components/book/BookView'
import BookViewSwitch from '../components/book/BookViewSwitch'
import MovePocketSheet from '../components/book/MovePocketSheet'
import Sheet from '../components/ui/Sheet'
import { moveSlot, pocketsFromSlots, slotPageCount, slotsRequestBody } from '../components/book/slotLayout'
import { readViewPreference, writeViewPreference } from '../components/book/bookPages'
import { useDynamicFilterUrlState } from '../hooks/useDynamicFilterUrlState'
import PrintingDetailBadges from '../components/PrintingDetailBadges'

const SPRITE_BASE_URL = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated'
const BINDER_FILTER_DEFINITIONS = {
  binderFilterSet: { param: 'binder_set', default: '' },
  binderFilterStatus: { param: 'binder_status', default: '' },
}

function BinderConversionModal({ t, target, onClose, onConfirm, isSubmitting }) {
  const isCollectionTarget = target === 'collection'
  return (
    <Modal
      isOpen={Boolean(target)}
      onClose={isSubmitting ? undefined : onClose}
      title={isCollectionTarget ? t('binderTypes.convertWishlist') : t('binderTypes.convertCollection')}
      size="md"
      mobileSheet={false}
    >
      <div className="space-y-4 p-5">
        <p className="text-sm text-text-secondary">
          {isCollectionTarget ? t('binderTypes.convertWishlistConfirm') : t('binderTypes.convertCollectionConfirm')}
        </p>
        <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
          <button type="button" className="btn-ghost w-full sm:w-auto" disabled={isSubmitting} onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn-primary w-full whitespace-normal px-5 sm:w-auto" disabled={isSubmitting} onClick={onConfirm}>
            {isCollectionTarget ? <Package size={16} className="flex-shrink-0" /> : <Star size={16} className="flex-shrink-0" />}
            {isCollectionTarget ? t('binderTypes.convertWishlist') : t('binderTypes.convertCollection')}
          </button>
        </div>
      </div>
    </Modal>
  )
}

export default function BinderDetail() {
  const { binderId } = useParams()
  const navigate = useNavigate()
  const { t, formatPrice, pricePrimaryField, settings } = useSettings()
  const label = (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), t(key))
  const queryClient = useQueryClient()
  const [showSearch, setShowSearch] = useState(false)
  const [binderFilterQuery, setBinderFilterQuery] = useState('')
  const [binderSortBy, setBinderSortBy] = useState('recent')
  const [viewMode, setViewMode] = useState(() => readViewPreference('binder'))
  const changeViewMode = mode => {
    setViewMode(mode)
    writeViewPreference('binder', mode)
  }
  const {
    filters: binderFilters,
    updateFilter: updateBinderFilter,
    clearFilters: clearBinderFilters,
  } = useDynamicFilterUrlState(BINDER_FILTER_DEFINITIONS)
  const { binderFilterSet, binderFilterStatus } = binderFilters
  const [badgeLegendOpen, setBadgeLegendOpen] = useState(false)
  const [selectedCard, setSelectedCard] = useState(null)
  const [selectedSlot, setSelectedSlot] = useState(null)
  const [moveTarget, setMoveTarget] = useState(null)
  const [closeGapsOpen, setCloseGapsOpen] = useState(false)
  const [pocketSizeOpen, setPocketSizeOpen] = useState(false)
  const [selectedImageSource, setSelectedImageSource] = useState('catalogue')
  const [selectedCardTab, setSelectedCardTab] = useState('binder')
  const selectedCardPhotoItem = selectedCard
    ? {
        id: selectedCard.collection_item_id,
        card_id: selectedCard.card_id || selectedCard.id,
        has_scan_photo: selectedCard.has_scan_photo,
        card: selectedCard,
      }
    : null
  const preferOwnPhotos = settings.prefer_own_card_photos === 'true'
  const selectedCardOwnPhoto = showsOwnPhoto(selectedCardPhotoItem, selectedCard, preferOwnPhotos)
  const selectedCardPhotoUrl = useCollectionPhotoUrl(selectedCardPhotoItem, { eager: true })
  const selectedCardHasReference = hasCatalogueImage(selectedCard) || Boolean(selectedCard?.custom_image_url)
  const selectedCardDefaultSource = selectedCardOwnPhoto ? 'own' : 'catalogue'
  const selectedCardImage = selectedImageSource === 'own' && selectedCardPhotoUrl
    ? selectedCardPhotoUrl
    : resolveCardImageUrl(selectedCard, 'large')

  useEffect(() => {
    setSelectedImageSource(selectedCardDefaultSource)
  }, [selectedCard?.binder_card_id, selectedCardDefaultSource])
  const [showCsvImportModal, setShowCsvImportModal] = useState(false)
  const [showPrintOptimizer, setShowPrintOptimizer] = useState(false)
  const [selectedPrintOptimizationIds, setSelectedPrintOptimizationIds] = useState([])
  const [quantityDialog, setQuantityDialog] = useState(null)
  const [pickerQuantities, setPickerQuantities] = useState({})
  const [conversionTarget, setConversionTarget] = useState(null)
  const fileInputRef = useRef(null)
  const selectedCardCloseRef = useRef(null)

  const { data, isLoading } = useQuery({
    queryKey: ['binder-cards', binderId, pricePrimaryField],
    queryFn: () => getBinderCards(parseInt(binderId), { price_field: pricePrimaryField }).then(r => r.data),
  })

  const binder = data?.binder
  const binderType = binder?.binder_type || 'collection'
  const isWishlist = binderType === 'wishlist'
  const isCollection = binderType === 'collection'
  const availableCollectionItemQuantities = data?.available_collection_item_quantities || {}

  const { data: collectionData } = useQuery({
    queryKey: ['collection'],
    queryFn: () => getCollection({}).then(r => r.data),
    enabled: Boolean(binder),
  })


  // Book view: the pockets (P5). The server assigns them lazily and keeps them in step with the cards.
  const slotsKey = ['binder-slots', binderId]
  const slotsEnabled = viewMode === 'book' && Boolean(binder) && (isWishlist || isCollection)
  const { data: slotData } = useQuery({
    queryKey: slotsKey,
    queryFn: () => getBinderSlots(parseInt(binderId)),
    enabled: slotsEnabled,
  })
  // A card added, removed or re-counted on this page changes the pockets on the server: load them again.
  const cardsRevision = useRef(data)
  useEffect(() => {
    if (cardsRevision.current === data) return
    cardsRevision.current = data
    if (slotsEnabled) queryClient.invalidateQueries({ queryKey: ['binder-slots', binderId] })
  }, [data, slotsEnabled, binderId, queryClient])

  const bookItems = useMemo(() => {
    if (!slotData) return []
    const entries = new Map((Array.isArray(data?.cards) ? data.cards : []).map(entry => [entry.binder_card_id, entry]))
    const pockets = pocketsFromSlots(slotData.slots, slotData.pocket_layout, slotPageCount(slotData.slots, slotData.pocket_layout))
    return pockets.map(slot => {
      if (!slot) return null
      const key = `${slot.binder_card_id}:${slot.copy_index}`
      const entry = entries.get(slot.binder_card_id)
      if (!entry) return { key, slotIndex: slot.slot_index, card: { id: key, name: '' }, source: null, number: '', name: '', ghost: true, hidden: true }
      const card = entry.card || entry
      const ownedQuantity = Number(entry.available_quantity ?? entry.owned_quantity ?? card.owned_quantity) || 0
      // A planned card is a ghost for every copy the trainer does not own yet.
      const ghost = isWishlist && slot.copy_index >= ownedQuantity
      return {
        key,
        slotIndex: slot.slot_index,
        copyIndex: slot.copy_index,
        card: { ...card, owned: !ghost, owned_quantity: ownedQuantity },
        source: entry,
        number: card.number ?? '',
        name: card.name ?? '',
        ghost,
      }
    })
  }, [slotData, data, isWishlist])

  const requireConnection = () => {
    if (!isOffline()) return true
    toast.error(t('book.needsConnection'))
    return false
  }
  const slotErrorMessage = (error, fallback) => {
    if (error?.isOfflineRefusal) return t('book.needsConnection')
    if (error?.response?.status === 409) return t('book.layoutChanged')
    return fallback
  }

  const slotMutation = useMutation({
    mutationFn: ({ nextSlots, version }) => replaceBinderSlots(parseInt(binderId), slotsRequestBody(version, nextSlots)),
    // Optimistic: the card lands at once; a failed save puts the old layout back.
    onMutate: async ({ nextSlots }) => {
      await queryClient.cancelQueries({ queryKey: ['binder-slots', binderId] })
      const previous = queryClient.getQueryData(['binder-slots', binderId])
      queryClient.setQueryData(['binder-slots', binderId], old => (old ? { ...old, slots: nextSlots } : old))
      return { previous }
    },
    onError: (error, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(['binder-slots', binderId], context.previous)
      toast.error(slotErrorMessage(error, t('book.moveFailed')))
    },
    onSuccess: payload => queryClient.setQueryData(['binder-slots', binderId], payload),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['binder-slots', binderId] }),
  })

  const compactMutation = useMutation({
    mutationFn: () => compactBinderSlots(parseInt(binderId)),
    onSuccess: payload => {
      queryClient.setQueryData(['binder-slots', binderId], payload)
      toast.success(t('book.closeGapsDone'))
    },
    onError: error => toast.error(slotErrorMessage(error, t('book.closeGapsFailed'))),
  })

  const pocketSizeMutation = useMutation({
    mutationFn: pocketLayout => updateBinder(parseInt(binderId), { pocket_layout: pocketLayout }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['binder-slots', binderId] })
      queryClient.invalidateQueries({ queryKey: ['binder-cards'] })
    },
    onError: error => toast.error(slotErrorMessage(error, t('book.pocketSizeFailed'))),
  })

  const moveSlotTo = (from, to) => {
    if (!slotData || slotMutation.isPending || !requireConnection()) return
    const nextSlots = moveSlot(slotData.slots, from, to)
    if (nextSlots === slotData.slots) return
    slotMutation.mutate({ nextSlots, version: slotData.version })
  }
  // Releasing a lifted card without moving it opens Move to…
  const holdSlot = index => {
    const item = bookItems[index]
    if (item && !item.hidden) setMoveTarget({ name: item.name, slotIndex: index })
  }

  const pickerSelectionMutation = useMutation({
    mutationFn: async ({ items }) => {
      const pickerIds = items.map(item => item.id)
      const requests = items.map(({ id, quantity }) => (
        isWishlist
          ? addCardToBinder(parseInt(binderId), id, quantity)
          : addCollectionItemToBinder(parseInt(binderId), id, quantity)
      ))
      const results = await Promise.allSettled(requests)
      return partitionSettledResults(pickerIds, results)
    },
    onSuccess: ({ succeededIds, failed }) => {
      if (failed.length === 0) {
        toast.success(`${t('common.add')} ${succeededIds.length} ✓`)
      } else if (succeededIds.length > 0) {
        toast.error(`${succeededIds.length} ✓ · ${failed.length} ${t('card.addFailed')}`)
      } else {
        const detail = failed[0]?.reason?.response?.data?.detail
        toast.error(detail || t('card.addFailed'))
      }
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] }),
        queryClient.invalidateQueries({ queryKey: ['binders'] }),
      ])
      invalidateTcgdexFilterLanguages(queryClient)
    },
  })

  const removeMutation = useMutation({
    mutationFn: ({ cardId, binderCardId }) => binderCardId
      ? removeBinderEntry(parseInt(binderId), binderCardId)
      : removeCardFromBinder(parseInt(binderId), cardId),
    onSuccess: () => {
      toast.success(t('common.remove') + ' ✓')
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      invalidateTcgdexFilterLanguages(queryClient)
      queryClient.invalidateQueries({ queryKey: ['binders'] })
    },
  })

  const updateEntryMutation = useMutation({
    mutationFn: ({ binderCardId, requiredQuantity }) => updateBinderEntry(parseInt(binderId), binderCardId, { required_quantity: requiredQuantity }),
    onSuccess: (_data, variables) => {
      setSelectedCard(prev => {
        if (!prev || prev.binder_card_id !== variables.binderCardId) return prev
        const priorQuantity = prev.required_quantity || 1
        return {
          ...prev,
          required_quantity: variables.requiredQuantity,
          owned_quantity: isCollection ? variables.requiredQuantity : prev.owned_quantity,
          quantity: isCollection ? variables.requiredQuantity : prev.quantity,
          available_quantity: isCollection
            ? Math.max((prev.available_quantity || 0) + priorQuantity - variables.requiredQuantity, 0)
            : prev.available_quantity,
          missing_quantity: isCollection ? 0 : Math.max(variables.requiredQuantity - (prev.owned_quantity || 0), 0),
        }
      })
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      invalidateTcgdexFilterLanguages(queryClient)
      queryClient.invalidateQueries({ queryKey: ['binders'] })
    },
    onError: (e) => toast.error(e.response?.data?.detail || 'Update failed'),
  })

  useEffect(() => {
    if (!selectedCard) return undefined
    setSelectedCardTab('binder')
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setSelectedCard(null)
    }
    document.addEventListener('keydown', handleKeyDown)
    selectedCardCloseRef.current?.focus()
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [selectedCard])

  const wishlistMutation = useMutation({
    mutationFn: ({ binderCardId, quantity = null }) => addBinderEntryToWishlist(parseInt(binderId), binderCardId, quantity),
    onSuccess: (result) => {
      if (result?.added > 0) {
        const copies = result?.added_copies ? ` (${result.added_copies} ${t('binderTypes.addedCopies')})` : ''
        toast.success((isWishlist ? t('binderTypes.addMissingToWishlist') : t('binderTypes.addToWishlist')) + ` ✓${copies}`)
      } else if (result?.skipped_complete > 0) {
        toast(t('binderTypes.alreadyCompleteInCollection'))
      } else {
        toast(t('binderTypes.alreadyInWishlist'))
      }
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      setQuantityDialog(current => current?.mode === 'wishlist' ? null : current)
    },
    onError: (e) => toast.error(e.response?.data?.detail || t('card.addFailed')),
  })

  const bulkWishlistMutation = useMutation({
    mutationFn: () => addBinderCardsToWishlist(parseInt(binderId)),
    onSuccess: (result) => {
      const addedCopies = result.added_copies ?? result.added
      const summary = `${result.added} ${t('binderTypes.added')}, ${addedCopies} ${t('binderTypes.addedCopies')}, ${result.missing_copies || 0} ${t('binderTypes.missingCopies')}, ${result.skipped} ${t('binderTypes.skipped')}`
      if (result.added > 0) {
        toast.success(`${t('binderTypes.addMissingToWishlist')} ✓ (${summary})`)
      } else if (result.skipped_complete > 0 && result.skipped_existing === 0) {
        toast(`${t('binderTypes.alreadyCompleteInCollection')} (${summary})`)
      } else {
        toast(`${t('binderTypes.alreadyInWishlist')} (${summary})`)
      }
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
    },
    onError: (e) => toast.error(e.response?.data?.detail || t('card.addFailed')),
  })

  const convertWishlistMutation = useMutation({
    mutationFn: () => convertWishlistBinderToCollection(parseInt(binderId)),
    onSuccess: () => {
      toast.success(t('binderTypes.convertWishlistSuccess'))
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      queryClient.invalidateQueries({ queryKey: ['collection'] })
      queryClient.invalidateQueries({ queryKey: ['binder-print-optimization', binderId] })
      invalidateTcgdexFilterLanguages(queryClient)
      setShowPrintOptimizer(false)
      setConversionTarget(null)
    },
    onError: (e) => {
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      toast.error(e.response?.data?.detail || t('binderTypes.convertWishlistFailed'))
    },
  })

  const convertCollectionMutation = useMutation({
    mutationFn: () => convertCollectionBinderToWishlist(parseInt(binderId)),
    onSuccess: () => {
      toast.success(t('binderTypes.convertCollectionSuccess'))
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      queryClient.invalidateQueries({ queryKey: ['collection'] })
      queryClient.invalidateQueries({ queryKey: ['binder-print-optimization', binderId] })
      invalidateTcgdexFilterLanguages(queryClient)
      setShowPrintOptimizer(false)
      setSelectedCard(null)
      setQuantityDialog(null)
      setConversionTarget(null)
    },
    onError: (e) => {
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      toast.error(e.response?.data?.detail || t('binderTypes.convertCollectionFailed'))
    },
  })

  const updatePickerQuantity = (id, value) => {
    setPickerQuantities(current => ({ ...current, [id]: value }))
  }

  const submitQuantityDialog = () => {
    if (!quantityDialog) return
    const items = binderPickerItemsWithQuantities(quantityDialog.items, pickerQuantities)
    if (!binderPickerQuantitiesAreValid(items)) {
      toast.error(t('wishlist.quantityInvalid'))
      return
    }
    wishlistMutation.mutate({ binderCardId: items[0].id, quantity: items[0].quantity })
  }

  const openWishlistQuantityDialog = (card) => {
    const item = {
      id: card.binder_card_id,
      name: card.name,
      subtitle: [card.set_name, card.number, card.variant, card.condition].filter(Boolean).join(' · '),
      image: resolveCardImageUrl(card),
    }
    setPickerQuantities({ [item.id]: '1' })
    setSelectedCard(null)
    setQuantityDialog({ mode: 'wishlist', items: [item] })
  }

  const importMutation = useMutation({
    mutationFn: (file) => importBinderCsv(parseInt(binderId), file),
    onSuccess: (result) => {
      const message = `CSV: ${result.added} added, ${result.updated} updated${result.skipped ? `, ${result.skipped} skipped` : ''}${result.failed ? `, ${result.failed} failed` : ''}`
      if (result.failed > 0 && result.errors?.length) {
        toast.error(`${message}: ${result.errors.slice(0, 2).join('; ')}`)
      } else {
        toast.success(message)
      }
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      invalidateTcgdexFilterLanguages(queryClient)
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      setShowCsvImportModal(false)
    },
    onError: (e) => toast.error(getApiErrorMessage(e, 'CSV import failed')),
  })

  const exportMutation = useMutation({
    mutationFn: () => exportBinderCsv(parseInt(binderId)),
    onError: () => toast.error('CSV export failed'),
  })

  const { data: equivalentPrintsData, isLoading: equivalentPrintsLoading } = useQuery({
    queryKey: ['binder-entry-equivalents', binderId, binderType, selectedCard?.binder_card_id, pricePrimaryField],
    queryFn: () => getBinderEntryEquivalentPrints(parseInt(binderId), selectedCard.binder_card_id, { price_field: pricePrimaryField }),
    enabled: (isWishlist || isCollection) && !!selectedCard?.binder_card_id,
  })

  const switchPrintMutation = useMutation({
    mutationFn: ({ binderCardId, cardId, collectionItemId }) => switchBinderEntryCard(parseInt(binderId), binderCardId, cardId, collectionItemId),
    onSuccess: () => {
      toast.success(t('binderTypes.printSwitched') + ' ✓')
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      invalidateTcgdexFilterLanguages(queryClient)
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      setSelectedCard(null)
    },
    onError: (e) => toast.error(e.response?.data?.detail || t('binderTypes.printSwitchFailed')),
  })

  const { data: printOptimizationData, isLoading: printOptimizationLoading, isError: printOptimizationError, error: printOptimizationErrorData } = useQuery({
    queryKey: ['binder-print-optimization', binderId, pricePrimaryField],
    queryFn: () => getBinderPrintOptimization(parseInt(binderId), { price_field: pricePrimaryField }),
    enabled: (isWishlist || isCollection) && showPrintOptimizer,
    retry: false,
  })

  useEffect(() => {
    if (!showPrintOptimizer || !printOptimizationData) return
    setSelectedPrintOptimizationIds((printOptimizationData.recommendations || []).map(item => item.binder_card_id))
  }, [showPrintOptimizer, printOptimizationData])

  const applyPrintOptimizationMutation = useMutation({
    mutationFn: (selectedIds) => applyBinderPrintOptimization(parseInt(binderId), selectedIds, { price_field: pricePrimaryField }),
    onSuccess: (result) => {
      toast.success(`${t('binderTypes.optimizePrintsApplied')} ✓ (${result.applied} ${t('binderTypes.updated')}, ${result.skipped} ${t('binderTypes.skipped')}, ${formatPrice(result.total_savings || 0)})`)
      queryClient.invalidateQueries({ queryKey: ['binder-cards', binderId] })
      invalidateTcgdexFilterLanguages(queryClient)
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      queryClient.invalidateQueries({ queryKey: ['binder-print-optimization', binderId] })
      setShowPrintOptimizer(false)
    },
    onError: (e) => toast.error(e.response?.data?.detail || t('binderTypes.optimizePrintsFailed')),
  })

  // Secondary actions live in the nav bar's "⋯" menu; "Add cards" is the one primary action.
  const hasCards = Array.isArray(data?.cards) && data.cards.length > 0
  const navOptions = useMemo(() => {
    const items = []
    if (isCollection) {
      items.push({ id: 'convert', label: t('binderTypes.convertCollection'), icon: Star, disabled: convertCollectionMutation.isPending, onSelect: () => setConversionTarget('wishlist') })
    }
    items.push({ id: 'optimize', label: t('binderTypes.optimizePrints'), icon: Sparkles, disabled: !hasCards, onSelect: () => setShowPrintOptimizer(true) })
    if (isWishlist) {
      items.push({ id: 'missing', label: t('binderTypes.addMissingToWishlist'), icon: Heart, disabled: bulkWishlistMutation.isPending || !hasCards, onSelect: () => bulkWishlistMutation.mutate() })
    }
    if (viewMode === 'book' && (isCollection || isWishlist)) {
      items.push(
        { id: 'close-gaps', label: t('book.closeGaps'), icon: Grid2X2, disabled: !hasCards || compactMutation.isPending, onSelect: () => setCloseGapsOpen(true) },
        { id: 'pocket-size', label: t('book.pocketSize'), icon: BookOpen, disabled: !hasCards, onSelect: () => setPocketSizeOpen(true) },
      )
    }
    return {
      title: binder?.name || '',
      backLabel: t('nav.binders'),
      trailing: (
        <Menu
          label={t('binders.actionsLabel')}
          trigger={<IconButton icon={MoreHorizontal} label={t('binders.actionsLabel')} />}
          sections={[
            items,
            [
              { id: 'import', label: t('binderTypes.importCsv'), icon: Upload, disabled: importMutation.isPending, onSelect: () => setShowCsvImportModal(true) },
              { id: 'export', label: t('binderTypes.exportCsv'), icon: Download, disabled: exportMutation.isPending || !hasCards, onSelect: () => exportMutation.mutate() },
            ],
          ]}
        />
      ),
    }
  }, [t, binder?.name, isCollection, isWishlist, hasCards, viewMode, compactMutation.isPending, convertCollectionMutation, bulkWishlistMutation, importMutation, exportMutation])
  useNavBar(navOptions)

  useEffect(() => {
    if (binderType === 'deck') navigate(`/decks/${binderId}`, { replace: true })
  }, [binderId, binderType, navigate])

  if (isLoading) return <div className="skeleton h-64 rounded-xl" />
  if (binderType === 'deck') return <div className="skeleton h-64 rounded-xl" />

  const cards = Array.isArray(data?.cards) ? data.cards : []
  const unavailableCollectionItemIds = new Set(Array.isArray(data?.unavailable_collection_item_ids) ? data.unavailable_collection_item_ids : [])
  const ownedCount = data?.owned_count ?? cards.reduce((sum, c) => sum + Math.min(c.owned_quantity || 0, c.required_quantity || 1), 0)
  const totalCount = data?.total_required_count ?? data?.total_count ?? cards.length
  const uniqueCount = data?.unique_count ?? new Set(cards.map(card => card.id)).size
  const missingCount = data?.missing_count ?? cards.reduce((sum, c) => sum + (c.missing_quantity || 0), 0)
  const binderValue = data?.binder_value ?? cards.reduce((sum, c) => sum + ((c.price_market || 0) * (isWishlist ? (c.required_quantity || 1) : (c.quantity || 0))), 0)
  const currentValue = data?.current_value ?? cards.reduce((sum, c) => sum + ((c.price_market || 0) * (isWishlist ? Math.min(c.owned_quantity || 0, c.required_quantity || 1) : (c.quantity || 0))), 0)
  const costToComplete = data?.cost_to_complete ?? cards.reduce((sum, c) => sum + ((c.price_market || 0) * (c.missing_quantity || 0)), 0)
  const displayedValue = isWishlist ? costToComplete : binderValue
  const hasMissingPriceData = cards.length > 0 && displayedValue === 0 && (!isWishlist || missingCount > 0) && cards.some(c => !c.price_market || c.price_market <= 0)
  const hasMissingCurrentValueData = isWishlist && ownedCount > 0 && currentValue === 0 && cards.some(c => (c.owned_quantity || 0) > 0 && (!c.price_market || c.price_market <= 0))
  const progressPct = totalCount > 0 ? Math.round((ownedCount / totalCount) * 100) : 0
  const canConvertWishlist = canConvertWishlistBinder(isWishlist, totalCount, missingCount)
  const binderSets = [...new Set(cards.map(c => c.set_name || c.set_id).filter(Boolean))].sort()
  const printOptimizationRecommendations = Array.isArray(printOptimizationData?.recommendations) ? printOptimizationData.recommendations : []
  const hasOptimizations = printOptimizationRecommendations.length > 0
  const equivalentList = Array.isArray(equivalentPrintsData?.equivalents) ? equivalentPrintsData.equivalents : []
  const selectedPrintOptimizationIdSet = new Set(selectedPrintOptimizationIds)
  const selectedPrintOptimizationCount = printOptimizationRecommendations.filter(item => selectedPrintOptimizationIdSet.has(item.binder_card_id)).length
  const selectedPrintOptimizationSavings = printOptimizationRecommendations.reduce(
    (sum, item) => selectedPrintOptimizationIdSet.has(item.binder_card_id) ? sum + (item.total_savings || 0) : sum,
    0
  )
  const allPrintOptimizationsSelected = printOptimizationRecommendations.length > 0 && selectedPrintOptimizationCount === printOptimizationRecommendations.length
  const visibleCards = sortBinderCards(cards.filter(card => {
    const query = normalizeSearchText(binderFilterQuery)
    if (query && ![card.name, card.set_name, card.set_id, card.number].some(value => textIncludes(value, query))) return false
    if (binderFilterSet && (card.set_name || card.set_id) !== binderFilterSet) return false
    if (binderFilterStatus === 'owned' && (card.missing_quantity || 0) > 0) return false
    if (binderFilterStatus === 'missing' && (card.missing_quantity || 0) === 0) return false
    return true
  }), binderSortBy, { isWishlist })

  const changeRequiredQuantity = (card, delta) => {
    const maximum = isCollection ? (card.max_assignable_quantity || 1) : 99
    const next = Math.max(1, Math.min(maximum, (card.required_quantity || 1) + delta))
    updateEntryMutation.mutate({ binderCardId: card.binder_card_id, requiredQuantity: next })
  }

  const handleImportFile = (event) => {
    const file = event.target.files?.[0]
    if (file) importMutation.mutate(file)
    event.target.value = ''
  }

  const togglePrintOptimizationSelection = (binderCardId) => {
    setSelectedPrintOptimizationIds(prev => prev.includes(binderCardId)
      ? prev.filter(id => id !== binderCardId)
      : [...prev, binderCardId]
    )
  }

  const toggleAllPrintOptimizations = () => {
    setSelectedPrintOptimizationIds(allPrintOptimizationsSelected ? [] : printOptimizationRecommendations.map(item => item.binder_card_id))
  }

  const typeTone = isWishlist ? 'text-yellow' : 'text-blue'
  const stats = [
    [t('binderTypes.required'), totalCount, 'text-text-primary'],
    [t('binderTypes.owned'), ownedCount, 'text-green'],
    [t('binderTypes.missing'), missingCount, 'text-red'],
    ...(isWishlist ? [[t('binderTypes.currentValue'), hasMissingCurrentValueData ? t('binderTypes.noPriceData') : formatPrice(currentValue), hasMissingCurrentValueData ? 'text-text-muted' : 'text-yellow']] : []),
    [isWishlist ? t('binderTypes.costToComplete') : t('binderTypes.binderValue'), hasMissingPriceData ? t('binderTypes.noPriceData') : formatPrice(displayedValue), hasMissingPriceData ? 'text-text-muted' : 'text-yellow'],
  ]

  return (
    <div className="space-y-4 pb-2">
      <div className="flex items-center gap-3">
        <span
          className="grid h-12 w-12 flex-shrink-0 place-items-center overflow-hidden rounded-xl"
          style={{ background: `color-mix(in srgb, ${binder?.color || '#3b82f6'} 28%, #000)` }}
        >
          {binder?.icon_pokemon_id ? (
            <img src={`${SPRITE_BASE_URL}/${binder.icon_pokemon_id}.gif`} alt="" className="h-9 w-9 pixelated object-contain" loading="lazy" />
          ) : isWishlist ? (
            <Star size={22} style={{ color: binder?.color }} aria-hidden="true" />
          ) : (
            <Package size={22} style={{ color: binder?.color }} aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-title-3 font-bold text-text-primary">{binder?.name}</h1>
          <p className="text-footnote text-text-secondary">
            <span className={typeTone}>{isWishlist ? t('binderTypes.planned') : t('binderTypes.collection')}</span>
            {' · '}{formatBinderCountSummary(totalCount, uniqueCount, t)}
          </p>
        </div>
      </div>
      {binder?.description && <p className="text-sm text-text-secondary">{binder.description}</p>}

      <button
        onClick={() => {
          if (showSearch) clearPickerSelection()
          setShowSearch(!showSearch)
        }}
        className="btn-primary w-full justify-center sm:w-auto"
      >
        <Plus size={16} /> {t('binders.addCards')}
      </button>
      <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleImportFile} />

      <div className="space-y-3 rounded-2xl bg-card p-4">
        <div className={`grid gap-3 ${isWishlist ? 'grid-cols-2 sm:grid-cols-5' : 'grid-cols-3'}`}>
          {stats.map(([statLabel, value, tone]) => (
            <div key={statLabel} className="min-w-0">
              <p className="truncate text-footnote text-text-muted">{statLabel}</p>
              <p className={`truncate text-title-3 font-bold ${tone}`}>{value}</p>
            </div>
          ))}
        </div>
        {isWishlist && cards.length > 0 && (
          <div className="space-y-1.5">
            <HpBar value={ownedCount} max={totalCount} label={t('binderTypes.progress')} />
            <p className="text-footnote text-text-secondary">{ownedCount} {t('binderTypes.ownedOf')} {totalCount} {t('binderTypes.cards')} ({progressPct}%)</p>
          </div>
        )}
        {isWishlist && canConvertWishlist && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-footnote text-green">{t('binderTypes.convertWishlistReady')}</p>
            <button
              type="button"
              className="btn-primary justify-center"
              disabled={convertWishlistMutation.isPending}
              onClick={() => setConversionTarget('collection')}
            >
              <Package size={16} /> {t('binderTypes.convertWishlist')}
            </button>
          </div>
        )}
      </div>

      <CardListPicker
        key={binderType}
        open={showSearch}
        title={isWishlist ? t('binderTypes.addAnyCard') : t('binderTypes.addFromCollection')}
        collection={collectionData || []}
        existingCardIds={cards.map(card => card.id)}
        unavailableCollectionItemIds={unavailableCollectionItemIds}
        maxQuantityById={availableCollectionItemQuantities}
        selectionMode={isWishlist ? 'card' : 'collection-item'}
        allowCatalog={isWishlist}
        onSubmit={items => pickerSelectionMutation.mutateAsync({ items })}
        isSubmitting={pickerSelectionMutation.isPending}
        t={t}
        label={label}
      />

      {cards.length > 0 && (
        <>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setBadgeLegendOpen(open => !open)}
              className={`btn-ghost px-3 py-2 text-sm ${
                badgeLegendOpen ? 'border-brand-red/30 bg-brand-red/10 text-brand-red' : ''
              }`}
              aria-expanded={badgeLegendOpen}
              aria-controls="private-binder-card-badge-legend"
            >
              <HelpCircle size={15} />
              <span>{t('setDetail.badgeLegend')}</span>
            </button>
          </div>
          {badgeLegendOpen && (
            <div id="private-binder-card-badge-legend" className="card p-3">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                {t('setDetail.badgeLegend')}
              </p>
              <CardLegend
                collapsible={false}
                showWishlist={false}
                showQuantity={!isCollection}
                showSelection={showSearch}
                showBinderProgress={isWishlist}
              />
              {isCollection && <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
                <span className="inline-flex flex-shrink-0 items-center rounded-full bg-green/80 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white shadow-xs">
                  2x
                </span>
                <span className="text-xs leading-tight text-text-secondary">
                  {t('binderTypes.amountInBinder')}
                </span>
              </div>}
            </div>
          )}
        </>
      )}

      {cards.length > 0 && (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          {viewMode !== 'book' && <>
          <input
            type="text"
            value={binderFilterQuery}
            onChange={(e) => setBinderFilterQuery(e.target.value)}
            placeholder={t('binderTypes.filterBinderCards')}
            className="input col-span-2 text-sm py-2 lg:col-span-4"
          />
          <select aria-label={t('binderTypes.allSets')} className="select text-sm py-2" value={binderFilterSet} onChange={(e) => updateBinderFilter('binderFilterSet', e.target.value)}>
            <option value="">{t('binderTypes.allSets')}</option>
            {binderSets.map(setName => <option key={setName} value={setName}>{setName}</option>)}
          </select>
          <select aria-label={t('binderTypes.allStatuses')} className="select text-sm py-2" value={binderFilterStatus} onChange={(e) => updateBinderFilter('binderFilterStatus', e.target.value)}>
            <option value="">{t('binderTypes.allStatuses')}</option>
            <option value="owned">{t('binderTypes.ownedComplete')}</option>
            <option value="missing">{t('binderTypes.missingCards')}</option>
          </select>
          <select
            className="select text-sm py-2"
            value={binderSortBy}
            onChange={(e) => setBinderSortBy(e.target.value)}
            aria-label={t('binderTypes.sortBy')}
          >
            {BINDER_SORT_OPTIONS
              .filter(option => isCollection || option !== 'variant_asc')
              .map(option => (
                <option key={option} value={option}>{t(`binderTypes.sort.${option}`)}</option>
              ))}
          </select>
          </>}
          <div className="col-span-2 flex flex-wrap items-center justify-between gap-2 lg:col-span-4">
            {viewMode === 'book' ? <p className="book-gap-hint text-footnote">{t('book.holdHint')}</p> : <button type="button" className="btn-ghost" onClick={clearBinderFilters}>{t('common.clear')}</button>}
            <BookViewSwitch value={viewMode} onChange={changeViewMode} />
          </div>
        </div>
      )}

      {cards.length === 0 ? (
        <div className="card text-center py-20">
          <p className="text-text-muted">
            {isWishlist ? `⭐ ${t('binderTypes.emptyPlanned')}` : `📦 ${t('binderTypes.emptyCollection')}`}
          </p>
          <p className="text-xs text-text-muted mt-1">
            {isWishlist ? t('binderTypes.addAnyCard') : t('binderTypes.addFromCollection')}
          </p>
        </div>
      ) : visibleCards.length === 0 && viewMode !== 'book' ? (
        <div className="card text-center py-12 text-text-muted">{t('common.noResults')}</div>
      ) : viewMode === 'book' ? (
        !(isCollection || isWishlist) ? null : !slotData ? (
          <div className="skeleton h-64 rounded-xl" />
        ) : (
          <BookView
            items={bookItems}
            pocketLayout={slotData.pocket_layout}
            resetKey={String(binderId)}
            onMoveSlot={slotMutation.isPending ? undefined : moveSlotTo}
            onHold={holdSlot}
            renderPocket={item => (
              <CardDisplay
                variant="artwork"
                card={item.card}
                image={resolveCardImageUrl(item.card)}
                alt={item.name || t('book.emptyPocket')}
                interactive={!item.hidden}
                dimmed={item.ghost}
                onClick={() => {
                  if (item.hidden) return
                  setSelectedSlot(item.slotIndex)
                  setSelectedCard(item.source)
                }}
              />
            )}
          />
        )
      ) : (
        <CardListGallery
          entries={visibleCards}
          mode={isWishlist ? 'planned' : 'physical'}
          onOpen={card => { setSelectedSlot(null); setSelectedCard(card) }}
          t={t}
          formatPrice={formatPrice}
          pricePrimaryField={pricePrimaryField}
        />
      )}


      <MovePocketSheet
        item={moveTarget}
        slots={slotData?.slots || []}
        layout={slotData?.pocket_layout ?? binder?.pocket_layout}
        nameFor={slot => bookItems[slot.slot_index]?.name || ''}
        onConfirm={to => moveSlotTo(moveTarget.slotIndex, to)}
        onClose={() => setMoveTarget(null)}
      />

      <Modal isOpen={closeGapsOpen} onClose={() => setCloseGapsOpen(false)} title={t('book.closeGapsTitle')} size="md" mobileSheet={false}>
        <div className="space-y-4 p-5">
          <p className="text-sm text-text-secondary">{t('book.closeGapsBody')}</p>
          <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
            <button type="button" className="btn-ghost w-full sm:w-auto" onClick={() => setCloseGapsOpen(false)}>{t('common.cancel')}</button>
            <button
              type="button"
              className="btn-primary w-full px-5 sm:w-auto"
              disabled={compactMutation.isPending}
              onClick={() => {
                if (!requireConnection()) return
                setCloseGapsOpen(false)
                compactMutation.mutate()
              }}
            >
              {t('book.closeGaps')}
            </button>
          </div>
        </div>
      </Modal>

      <Sheet isOpen={pocketSizeOpen} onClose={() => setPocketSizeOpen(false)} title={t('book.pocketSizeTitle')}>
        <div className="space-y-3 p-4">
          <p className="text-footnote text-text-secondary">{t('book.pocketSizeHelp')}</p>
          <div className="grid grid-cols-3 gap-2" role="group" aria-label={t('book.pocketSizeTitle')}>
            {[4, 9, 12].map(count => (
              <button
                key={count}
                type="button"
                aria-pressed={(slotData?.pocket_layout ?? binder?.pocket_layout ?? 9) === count}
                className={`min-h-[44px] rounded-xl px-2 text-sm font-semibold ${(slotData?.pocket_layout ?? binder?.pocket_layout ?? 9) === count ? 'bg-accent text-on-accent' : 'bg-fill-tertiary'}`}
                disabled={pocketSizeMutation.isPending}
                onClick={() => {
                  if (!requireConnection()) return
                  setPocketSizeOpen(false)
                  if (count !== (slotData?.pocket_layout ?? binder?.pocket_layout ?? 9)) pocketSizeMutation.mutate(count)
                }}
              >
                {t('book.pocketSizeOption').replace('{count}', count)}
              </button>
            ))}
          </div>
        </div>
      </Sheet>

      {showCsvImportModal && (
        <BinderCsvImportModal
          t={t}
          listType={isWishlist ? 'planned' : 'collection'}
          onClose={() => setShowCsvImportModal(false)}
          onChooseFile={() => fileInputRef.current?.click()}
          onDownloadTemplate={downloadBinderCsvTemplate}
          isImporting={importMutation.isPending}
        />
      )}

      <PageSheet
        isOpen={showPrintOptimizer}
        onClose={() => setShowPrintOptimizer(false)}
        title={t('binderTypes.optimizePrints')}
        footer={hasOptimizations && !printOptimizationError ? (
          <button
            type="button"
            className="btn-primary w-full justify-center"
            disabled={applyPrintOptimizationMutation.isPending || selectedPrintOptimizationCount === 0}
            onClick={() => applyPrintOptimizationMutation.mutate(selectedPrintOptimizationIds)}
          >
            {applyPrintOptimizationMutation.isPending ? t('binderTypes.optimizingPrints') : t('binderTypes.applyOptimization')}
          </button>
        ) : undefined}
      >
        <div className="space-y-4 p-4" data-testid="optimize-sheet-content">
          <p className="text-xs text-text-secondary">{t('binderTypes.optimizePrintsHelp')}</p>
      {printOptimizationLoading && <p className="text-sm text-text-muted text-center py-6">{t('binderTypes.optimizingPrints')}</p>}

      {printOptimizationError && (
        <p className="rounded-xl bg-brand-red/10 p-4 text-sm text-brand-red text-center">
          {printOptimizationErrorData?.response?.data?.detail || t('binderTypes.optimizePrintsFailed')}
        </p>
      )}

      {!printOptimizationLoading && !printOptimizationError && (printOptimizationData?.recommendations || []).length === 0 && (
        <p className="rounded-xl bg-bg-card/60 p-4 text-sm text-text-muted text-center">{t('binderTypes.noPrintOptimizations')}</p>
      )}

      {!printOptimizationError && (printOptimizationData?.recommendations || []).length > 0 && (
        <>
          <div className="rounded-xl bg-yellow/10 px-3 py-2 text-xs text-yellow space-y-1">
            <p>{t('binderTypes.optimizePrintsSummary')}: {printOptimizationData.change_count} · {formatPrice(printOptimizationData.total_savings || 0)}</p>
            <p>{t('binderTypes.selectedOptimizationSummary')}: {selectedPrintOptimizationCount} · {formatPrice(selectedPrintOptimizationSavings)}</p>
          </div>
          <label className="inline-flex items-center gap-2 text-xs text-text-secondary">
            <input
              type="checkbox"
              className="accent-brand-red"
              checked={allPrintOptimizationsSelected}
              onChange={toggleAllPrintOptimizations}
            />
            {t('binderTypes.selectAllOptimizations')}
          </label>
          <div className="space-y-2">
            {printOptimizationData.recommendations.map((item) => {
              const isSelected = selectedPrintOptimizationIdSet.has(item.binder_card_id)
              return (
                <div key={item.binder_card_id} className={`rounded-xl border p-3 ${isSelected ? 'border-yellow/40 bg-yellow/5' : 'border-border bg-bg-card/60'}`}>
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-2 accent-brand-red"
                      checked={isSelected}
                      onChange={() => togglePrintOptimizationSelection(item.binder_card_id)}
                      aria-label={t('cardSearch.select')}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_32px_minmax(0,1fr)_auto] md:items-center">
                        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-bg-elevated/50 p-2">
                          <CollectionCardDisplay variant="compact-artwork" item={{ id: item.current.collection_item_id, has_scan_photo: item.current.has_scan_photo, card: item.current.card }} card={item.current} image={resolveCardImageUrl(item.current)} alt={item.current.name} variantEffectSource={item.current.variant} />
                          <div className="min-w-0">
                            <p className="text-[9px] font-bold uppercase tracking-wide text-text-muted">{t('binderTypes.currentPrint')}</p>
                            <p className="truncate text-xs font-semibold text-text-primary">{item.current.set_name || item.current.set_id} #{item.current.number}</p>
                            <p className="text-[11px] text-text-muted">{item.current_price ? formatPrice(item.current_price) : t('binderTypes.noPriceDataShort')}</p>
                            {(item.current.variant || item.current.condition) && <p className="truncate text-[10px] text-text-muted">{[item.current.variant, item.current.condition].filter(Boolean).join(' · ')}</p>}
                          </div>
                        </div>
                        <span className="mx-auto text-sm font-bold text-green">
                          <span className="md:hidden">↓</span>
                          <span className="hidden md:inline">→</span>
                        </span>
                        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-green/30 bg-green/5 p-2">
                          <CollectionCardDisplay variant="compact-artwork" item={{ id: item.suggested.collection_item_id, has_scan_photo: item.suggested.has_scan_photo, card: item.suggested.card }} card={item.suggested} image={resolveCardImageUrl(item.suggested)} alt={item.suggested.name} variantEffectSource={item.suggested.variant} />
                          <div className="min-w-0">
                            <p className="text-[9px] font-bold uppercase tracking-wide text-green">{t('binderTypes.suggestedPrint')}</p>
                            <p className="truncate text-xs font-semibold text-text-primary">{item.suggested.set_name || item.suggested.set_id} #{item.suggested.number}</p>
                            <p className="text-[11px] text-green">{formatPrice(item.suggested_price)}</p>
                            {(item.suggested.variant || item.suggested.condition) && <p className="truncate text-[10px] text-text-muted">{[item.suggested.variant, item.suggested.condition].filter(Boolean).join(' · ')}</p>}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn-ghost justify-center border-green/30 text-green"
                          disabled={applyPrintOptimizationMutation.isPending}
                          onClick={() => applyPrintOptimizationMutation.mutate([item.binder_card_id])}
                        >
                          {t('binderTypes.switchPrint')}
                        </button>
                      </div>
                      <p className="mt-2 text-[11px] text-text-muted">
                        {item.required_quantity}x · {t('binderTypes.estimatedSavings')}: {formatPrice(item.total_savings)}
                      </p>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
        </div>
      </PageSheet>

      <CardSelectionQuantityModal
        t={t}
        items={quantityDialog?.items || []}
        quantities={pickerQuantities}
        onQuantityChange={updatePickerQuantity}
        onClose={() => setQuantityDialog(null)}
        onSubmit={submitQuantityDialog}
        isSubmitting={pickerSelectionMutation.isPending || wishlistMutation.isPending}
      />

      <BinderConversionModal
        t={t}
        target={conversionTarget}
        onClose={() => setConversionTarget(null)}
        onConfirm={() => {
          if (conversionTarget === 'collection') convertWishlistMutation.mutate()
          else if (conversionTarget === 'wishlist') convertCollectionMutation.mutate()
        }}
        isSubmitting={convertWishlistMutation.isPending || convertCollectionMutation.isPending}
      />

      {selectedCard && (
        <CardDialog
          card={selectedCard}
          image={selectedCardImage}
          imageOverlay={selectedCardImage === selectedCardPhotoUrl && (
            <OwnPhotoOverlayBadge t={t} />
          )}
          imageAccessory={selectedCardPhotoUrl && selectedCardHasReference ? (
            <div className="grid grid-cols-2 gap-2" role="group" aria-label={t('collection.photoSource')}>
              <button
                type="button"
                onClick={() => setSelectedImageSource('catalogue')}
                aria-pressed={selectedImageSource === 'catalogue'}
                className={clsx(
                  'cursor-pointer rounded-lg border px-2 py-2 text-xs font-bold transition-colors',
                  selectedImageSource === 'catalogue'
                    ? 'border-brand-red bg-brand-red/15 text-brand-red'
                    : 'border-border bg-bg-card text-text-secondary hover:bg-bg-elevated'
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
                    : 'border-border bg-bg-card text-text-secondary hover:bg-bg-elevated'
                )}
              >
                {t('collection.myCardPhoto')}
              </button>
            </div>
          ) : null}
          variantEffectSource={selectedCard.variant}
          holo
          price={selectedCard.price_market > 0 ? formatPrice(selectedCard.price_market) : null}
          tabs={[
            { id: 'binder', label: t('cardTabs.binder') },
            ...((isWishlist || isCollection) ? [{ id: 'equivalents', label: t('cardTabs.equivalents') }] : []),
          ]}
          activeTab={selectedCardTab}
          onTabChange={setSelectedCardTab}
          onClose={() => setSelectedCard(null)}
          closeButtonRef={selectedCardCloseRef}
        >
          {selectedCardTab === 'binder' && (
            <div className="space-y-4">
                <div className="space-y-3 text-sm">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-bg-card p-2"><p className="text-xs text-text-muted">{t('binderTypes.owned')}</p><p className="font-bold text-green">{isCollection ? (selectedCard.collection_quantity || 0) : (selectedCard.owned_quantity || 0)}</p></div>
                    <div className="rounded-lg bg-bg-card p-2"><p className="text-xs text-text-muted">{t('binderTypes.missing')}</p><p className="font-bold text-brand-red">{selectedCard.missing_quantity || 0}</p></div>
                  </div>
                  {(isWishlist || (isCollection && selectedCard.collection_item_id)) ? (
                    <div>
                      <p className="text-xs text-text-muted mb-1">{isCollection ? t('binderTypes.amountInBinder') : t('binderTypes.requiredInBinder')}</p>
                      <div className="flex items-center gap-2">
                        <button className="btn-ghost px-2" onClick={() => changeRequiredQuantity(selectedCard, -1)} disabled={updateEntryMutation.isPending || (selectedCard.required_quantity || 1) <= 1}><Minus size={14} /></button>
                        <span className="text-lg font-bold text-text-primary min-w-8 text-center">{selectedCard.required_quantity || 1}</span>
                        <button className="btn-ghost px-2" onClick={() => changeRequiredQuantity(selectedCard, 1)} disabled={updateEntryMutation.isPending || (selectedCard.required_quantity || 1) >= (isCollection ? (selectedCard.max_assignable_quantity || 1) : 99)}><Plus size={14} /></button>
                      </div>
                      {isCollection && <p className="mt-1 text-xs text-text-muted">{selectedCard.available_quantity || 0} {t('products.available')}</p>}
                    </div>
                  ) : null}
                  <p className="text-xs text-text-muted">
                    {t('binderTypes.marketPrice')}: {selectedCard.price_market > 0 ? (
                      <span className="text-green font-semibold">{formatPrice(selectedCard.price_market)}</span>
                    ) : (
                      <span>{t('binderTypes.noPriceData')}</span>
                    )}
                  </p>
                  {(selectedCard.variant || selectedCard.condition) && <p className="text-xs text-text-muted">{[selectedCard.variant, selectedCard.condition].filter(Boolean).join(' · ')}</p>}
                  <PrintingDetailBadges details={selectedCard.printing_details} />
                </div>

              {viewMode === 'book' && slotData && selectedSlot != null && (
                <button
                  type="button"
                  className="btn-ghost w-full justify-center"
                  onClick={() => {
                    setMoveTarget({ name: selectedCard.name, slotIndex: selectedSlot })
                    setSelectedCard(null)
                  }}
                >
                  {t('book.moveTo')}
                </button>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button className="btn-ghost justify-center" onClick={() => {
                  if (isWishlist) {
                    wishlistMutation.mutate({ binderCardId: selectedCard.binder_card_id })
                    return
                  }
                  openWishlistQuantityDialog(selectedCard)
                }}>
                  <Heart size={16} /> {isWishlist ? t('binderTypes.addMissingToWishlist') : t('binderTypes.addToWishlist')}
                </button>
                <button className="btn-ghost justify-center text-brand-red" onClick={() => { removeMutation.mutate({ cardId: selectedCard.id, binderCardId: selectedCard.binder_card_id }); setSelectedCard(null) }}>
                  <Trash2 size={16} /> {t('common.remove')}
                </button>
                <button className="btn-primary justify-center" onClick={() => setSelectedCard(null)}>{t('binderTypes.done')}</button>
              </div>
            </div>
          )}

          {selectedCardTab === 'equivalents' && (isWishlist || isCollection) && (
                <div className="rounded-xl bg-bg-card/60 p-3 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-text-primary">{t('binderTypes.equivalentPrints')}</p>
                      <p className="text-xs text-text-muted">{isCollection ? t('binderTypes.equivalentPrintsCollectionHelp') : t('binderTypes.equivalentPrintsHelp')}</p>
                    </div>
                    {equivalentPrintsLoading && <span className="text-xs text-text-muted">{t('common.loading')}</span>}
                  </div>

                  {!equivalentPrintsLoading && equivalentList.length === 0 && (
                    <p className="text-xs text-text-muted">{t('binderTypes.noEquivalentPrints')}</p>
                  )}

                  {equivalentList.length > 0 && (
                    <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                      {equivalentPrintsData.equivalents.map((print) => {
                        const imageUrl = resolveCardImageUrl(print)
                        return (
                          <div key={print.collection_item_id || print.id} className={`flex items-center gap-3 rounded-lg border p-2 ${print.is_current ? 'border-yellow/40 bg-yellow/5' : 'border-border bg-bg/40'}`}>
                            <CollectionCardDisplay
                              variant="compact-artwork"
                              item={{ id: print.collection_item_id, has_scan_photo: print.has_scan_photo, card: print.card }}
                              card={print}
                              image={imageUrl}
                              alt={print.name}
                              variantEffectSource={print.variant}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-semibold text-text-primary truncate">{print.set_name || print.set_id} #{print.number}</p>
                              <div className="flex items-center gap-2 flex-wrap text-[11px] text-text-muted">
                                {print.lang && <span>{tcgdexLanguageLabel(print.lang)}</span>}
                                {print.rarity && <span>{print.rarity}</span>}
                                <span>{print.price_market > 0 ? formatPrice(print.price_market) : t('binderTypes.noPriceDataShort')}</span>
                                {print.variant && <span>{print.variant}</span>}
                                {print.condition && <span>{print.condition}</span>}
                                <PrintingDetailBadges details={print.printing_details} limit={2} />
                                {print.owned && <span className="text-green font-semibold">{t('binderTypes.owned')} {print.owned_quantity}x</span>}
                                {isCollection && !print.is_current && print.available_quantity < (selectedCard.required_quantity || 1) && <span className="text-yellow font-semibold">{t('binderTypes.alreadyUsed')}</span>}
                                {print.is_current && <span className="text-yellow font-semibold">{t('binderTypes.currentPrint')}</span>}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="btn-ghost px-2 py-1 text-xs flex-shrink-0"
                              disabled={print.is_current || switchPrintMutation.isPending || (isCollection && print.available_quantity < (selectedCard.required_quantity || 1))}
                              onClick={() => switchPrintMutation.mutate({ binderCardId: selectedCard.binder_card_id, cardId: print.id, collectionItemId: print.collection_item_id })}
                            >
                              {print.is_current ? t('binderTypes.currentPrint') : t('binderTypes.switchPrint')}
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
          )}
        </CardDialog>
      )}
    </div>
  )
}
