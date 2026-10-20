import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { MoreHorizontal, Copy, Download, Heart, Layers3, PackageCheck, Pencil, Plus, Trash2, Upload } from 'lucide-react'
import toast from 'react-hot-toast'
import { addBinderCardsToWishlist, addDeckEntry, convertDeckToPlanned, convertDeckToReal, deleteDeck, deleteDeckEntry, duplicateDeck, exportBinderCsv, getBinderEntryEquivalentPrints, getCollection, getDeck, importBinderCsv, switchBinderEntryCard, updateDeck } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { useNavBar } from '../navigation/useNavBar'
import HpBar from '../components/ios/HpBar'
import IconButton from '../components/ios/IconButton'
import Menu from '../components/ios/Menu'
import { useConfirmDialog } from '../contexts/ConfirmDialogContext'
import { useDeckQuantitySync } from '../hooks/useDeckQuantitySync'
import DeckCompositionBar from '../components/decks/DeckCompositionBar'
import DeckCardViewer from '../components/decks/DeckCardViewer'
import DeckValidationPanel from '../components/decks/DeckValidationPanel'
import DeckAnalyticsPanel from '../components/decks/DeckAnalyticsPanel'
import BinderCsvImportModal from '../components/binders/BinderCsvImportModal'
import CardListPicker from '../components/card-lists/CardListPicker'
import CardListGallery from '../components/card-lists/CardListGallery'
import { deckProgress, nextDeckCardIndex, previousDeckCardIndex, sortDeckEntries } from '../utils/deckProgress'

function invalidateDeck(queryClient, deckId) {
  queryClient.invalidateQueries({ queryKey: ['decks'] })
  queryClient.invalidateQueries({ queryKey: ['deck', String(deckId)] })
}

export default function DeckEditor() {
  const { deckId } = useParams()
  const { t, formatPrice, pricePrimaryField } = useSettings()
  const navigate = useNavigate()
  const confirm = useConfirmDialog()
  const queryClient = useQueryClient()
  const csvInputRef = useRef(null)
  const [viewerIndex, setViewerIndex] = useState(null)
  const [view, setView] = useState('editor')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(() => typeof window !== 'undefined' && window.localStorage.getItem('pokecollector.deckEditor.ownedCardsCollapsed') === 'false')
  const [showCsvImportModal, setShowCsvImportModal] = useState(false)
  const label = (key, values) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), t(key))
  const { data: deck, isLoading } = useQuery({ queryKey: ['deck', deckId], queryFn: () => getDeck(deckId).then(response => response.data) })
  const { data: collection = [] } = useQuery({ queryKey: ['deck-picker-collection'], queryFn: () => getCollection({}).then(response => response.data) })

  const onSuccess = () => { invalidateDeck(queryClient, deckId); queryClient.invalidateQueries({ queryKey: ['deck-allocation'] }) }
  const updateMutation = useMutation({ mutationFn: data => updateDeck(deckId, data), onSuccess: () => { onSuccess(); setDetailsOpen(false); toast.success(t('decks.updated')) }, onError: error => toast.error(error.response?.data?.detail || t('decks.updateFailed')) })
  const showDeckMutationError = error => toast.error(
    error.response?.status === 429
      ? t('decks.tooManyRequests')
      : error.response?.status === 409
        ? t('decks.realDeckCopiesUnavailable')
        : error.response?.data?.detail || error.response?.data?.error || t('common.error'),
  )
  const handleDeckMutationError = error => { onSuccess(); showDeckMutationError(error) }
  const removeMutation = useMutation({ mutationFn: entryId => deleteDeckEntry(deckId, entryId), onSuccess, onError: handleDeckMutationError })
  const deleteMutation = useMutation({ mutationFn: () => deleteDeck(deckId), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['decks'] }); queryClient.invalidateQueries({ queryKey: ['binders'] }); navigate('/binders') }, onError: error => toast.error(error.response?.data?.detail || t('common.error')) })
  const duplicateMutation = useMutation({ mutationFn: () => duplicateDeck(deckId), onSuccess: response => { queryClient.invalidateQueries({ queryKey: ['decks'] }); queryClient.invalidateQueries({ queryKey: ['binders'] }); toast.success(t('decks.duplicated')); navigate(`/decks/${response.data.id}`) }, onError: error => toast.error(error.response?.data?.detail || t('common.error')) })
  const convertMutation = useMutation({
    mutationFn: type => type === 'physical_deck' ? convertDeckToReal(deckId) : convertDeckToPlanned(deckId),
    onSuccess: response => {
      onSuccess()
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      toast.success(response.data.binder_type === 'physical_deck' ? t('decks.convertedToReal') : t('decks.convertedToPlanned'))
    },
    onError: error => toast.error(error.response?.status === 409 ? t('decks.convertToRealUnavailable') : error.response?.data?.detail || t('common.error')),
  })
  const wishlistMutation = useMutation({
    mutationFn: () => addBinderCardsToWishlist(deckId),
    onSuccess: result => {
      queryClient.invalidateQueries({ queryKey: ['wishlist'] })
      const added = result?.added_copies || 0
      toast.success(added ? label('binderTypes.addedMissingCopies', { count: added }) : t('binderTypes.nothingMissingForWishlist'))
    },
    onError: error => toast.error(error.response?.data?.detail || t('common.error')),
  })
  const importMutation = useMutation({
    mutationFn: file => importBinderCsv(deckId, file),
    onSuccess: result => {
      onSuccess()
      setShowCsvImportModal(false)
      const summary = `${result.added} ${t('binderTypes.added')}, ${result.updated} ${t('binderTypes.updated')}${result.failed ? `, ${result.failed} ${t('binderTypes.failed')}` : ''}`
      result.failed ? toast.error(summary) : toast.success(summary)
    },
    onError: error => toast.error(error.response?.data?.detail || t('binderTypes.csvImportFailed')),
  })
  const exportMutation = useMutation({
    mutationFn: () => exportBinderCsv(deckId),
    onError: () => toast.error(t('binderTypes.csvExportFailed')),
  })
  const addEntriesMutation = useMutation({
    mutationFn: async items => {
      const succeededIds = []
      const failed = []
      let updatedDeck = null
      for (const item of items) {
        try {
          const response = await addDeckEntry(deckId, {
            card_id: item.id,
            required_quantity: item.quantity,
          })
          succeededIds.push(item.id)
          updatedDeck = response.data
        } catch (reason) {
          failed.push({ status: 'rejected', reason })
        }
      }
      return { succeededIds, failed, updatedDeck }
    },
    onSuccess: ({ succeededIds, failed, updatedDeck }) => {
      if (Array.isArray(updatedDeck?.entries)) queryClient.setQueryData(['deck', String(deckId)], updatedDeck)
      queryClient.invalidateQueries({ queryKey: ['decks'] })
      queryClient.invalidateQueries({ queryKey: ['deck-allocation'] })
      if (failed.length === 0) toast.success(`${t('common.add')} ${succeededIds.length} ✓`)
      else if (succeededIds.length > 0) toast.error(`${succeededIds.length} ✓ · ${failed.length} ${t('card.addFailed')}`)
      else showDeckMutationError(failed[0]?.reason)
    },
  })
  const { optimisticQuantities, pendingEntryIds, changeQuantity } = useDeckQuantitySync({ deckId, queryClient, onError: showDeckMutationError })
  const entries = sortDeckEntries((Array.isArray(deck?.entries) ? deck.entries : []).map(entry => optimisticQuantities[entry.id] === undefined ? entry : { ...entry, required_quantity: optimisticQuantities[entry.id] }))
  const activeEntry = viewerIndex === null ? null : entries?.[viewerIndex]
  const { data: equivalentPrints, isLoading: equivalentPrintsLoading } = useQuery({
    queryKey: ['binder-entry-equivalents', deckId, activeEntry?.id],
    queryFn: () => getBinderEntryEquivalentPrints(deckId, activeEntry.id),
    enabled: Boolean(activeEntry?.id) && deck?.binder_type !== 'physical_deck',
  })
  const switchPrintMutation = useMutation({
    mutationFn: cardId => switchBinderEntryCard(deckId, activeEntry.id, cardId),
    onSuccess: result => {
      onSuccess()
      setViewerIndex(null)
      toast.success(t('binderTypes.printSwitched'))
    },
    onError: error => toast.error(error.response?.data?.detail || t('binderTypes.printSwitchFailed')),
  })
  // Secondary actions live in the nav bar's "⋯" menu; "Add cards" is the one primary action.
  const realDeck = deck?.binder_type === 'physical_deck'
  const buildNavOptions = () => {
    const manage = []
    if (deck) {
      manage.push(realDeck
        ? { id: 'convert', label: t('decks.convertToPlanned'), icon: Layers3, disabled: convertMutation.isPending, onSelect: async () => { if (await confirm({ title: t('decks.convertToPlanned'), message: t('decks.convertToPlannedConfirm') })) convertMutation.mutate('deck') } }
        : { id: 'convert', label: t('decks.convertToReal'), icon: PackageCheck, disabled: convertMutation.isPending || deck.shared_missing_copy_count > 0, onSelect: async () => { if (await confirm({ title: t('decks.convertToReal'), message: t('decks.convertToRealConfirm') })) convertMutation.mutate('physical_deck') } })
      manage.push({ id: 'details', label: t('decks.editDetails'), icon: Pencil, onSelect: () => setDetailsOpen(value => !value) })
      if (!realDeck) manage.push({ id: 'missing', label: t('binderTypes.addMissingToWishlist'), icon: Heart, disabled: wishlistMutation.isPending || deck.missing_copy_count === 0, onSelect: () => wishlistMutation.mutate() })
    }
    const data = []
    if (!realDeck) data.push({ id: 'import', label: t('binderTypes.importDeckList'), icon: Upload, disabled: importMutation.isPending, onSelect: () => setShowCsvImportModal(true) })
    data.push({ id: 'export', label: t('binderTypes.exportDeckList'), icon: Download, disabled: exportMutation.isPending || entries.length === 0, onSelect: () => exportMutation.mutate() })
    data.push({ id: 'duplicate', label: t('decks.duplicate'), icon: Copy, disabled: duplicateMutation.isPending, onSelect: () => duplicateMutation.mutate() })
    return {
      title: deck?.name || '',
      backLabel: t('nav.binders'),
      trailing: deck ? (
        <Menu
          label={t('binders.actionsLabel')}
          trigger={<IconButton icon={MoreHorizontal} label={t('binders.actionsLabel')} />}
          sections={[
            manage,
            data,
            [{ id: 'delete', label: t('common.delete'), icon: Trash2, destructive: true, disabled: deleteMutation.isPending, onSelect: async () => { if (await confirm({ title: t('common.delete'), message: label('decks.deleteConfirm', { name: deck.name }) })) deleteMutation.mutate() } }],
          ]}
        />
      ) : null,
    }
  }
  const navOptions = buildNavOptions()
  useNavBar(navOptions)

  if (isLoading) return <div className="skeleton h-96 rounded-xl" />
  if (!deck) return null

  const isRealDeck = deck.binder_type === 'physical_deck'
  const progress = { ...deckProgress({ ...deck, current_card_count: entries.reduce((total, entry) => total + entry.required_quantity, 0) }), missing: deck.missing_copy_count }
  const saveDetails = event => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    updateMutation.mutate({ name: form.get('name'), description: form.get('description') || null, target_size: Number(form.get('target_size')), format: form.get('format') })
  }
  const previousCard = () => setViewerIndex(index => previousDeckCardIndex(index, entries.length))
  const nextCard = () => setViewerIndex(index => nextDeckCardIndex(index, entries.length))
  const setDeckPickerOpen = next => {
    setPickerOpen(next)
    window.localStorage.setItem('pokecollector.deckEditor.ownedCardsCollapsed', String(!next))
  }

  return (
    <div className="space-y-4 pb-6">
      <header className="space-y-3">
        <div className="flex items-center gap-3">
          <span
            className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-xl"
            style={{ background: `color-mix(in srgb, ${deck.color || (isRealDeck ? '#22c55e' : '#8b5cf6')} 28%, #000)` }}
          >
            {isRealDeck ? <PackageCheck size={22} style={{ color: deck.color || '#22c55e' }} aria-hidden="true" /> : <Layers3 size={22} style={{ color: deck.color || '#8b5cf6' }} aria-hidden="true" />}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-title-3 font-bold text-text-primary">{deck.name}</h1>
            <p className="text-footnote text-text-secondary">
              <span className={isRealDeck ? 'text-green' : 'text-purple-300'}>{isRealDeck ? t('binderTypes.realDeck') : t('binderTypes.plannedDeck')}</span>
              {' · '}{t(`decks.format${deck.format || 'Casual'}`)}
            </p>
          </div>
        </div>
        {deck.description && <p className="text-sm text-text-secondary">{deck.description}</p>}
        <div className="space-y-1.5">
          <HpBar value={progress.current} max={progress.target} label={t('binderTypes.progress')} />
          <p className="text-footnote text-text-secondary">{progress.current} / {progress.target} {t('decks.cards')}</p>
        </div>
        <button className="btn-primary w-full justify-center sm:w-auto" onClick={() => setDeckPickerOpen(!pickerOpen)} aria-expanded={pickerOpen} aria-controls="deck-owned-cards-content"><Plus size={16} /> {t('decks.addCards')}</button>
        <input ref={csvInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) importMutation.mutate(file); event.target.value = '' }} />
      </header>

      {detailsOpen && <form onSubmit={saveDetails} className="card grid gap-3 md:grid-cols-[1fr_10rem_10rem_auto] md:items-end">
        <label className="text-xs text-text-muted">{t('decks.name')}<input name="name" className="input mt-1" defaultValue={deck.name} required /></label>
        <label className="text-xs text-text-muted">{t('decks.target')}<select name="target_size" className="select mt-1" defaultValue={deck.target_size}>{[20, 40, 60].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
         <label className="text-xs text-text-muted">{t('decks.format')}<select name="format" className="select mt-1" defaultValue={deck.format || 'Casual'}>{['Casual', 'Standard', 'Expanded', 'Unlimited'].map(format => <option key={format} value={format}>{t(`decks.format${format}`)}</option>)}</select></label>
        <button className="btn-primary" disabled={updateMutation.isPending}>{t('common.save')}</button>
        <label className="text-xs text-text-muted md:col-span-4">{t('decks.description')}<input name="description" className="input mt-1" defaultValue={deck.description || ''} /></label>
       </form>}
       {!isRealDeck && deck.shared_missing_copy_count > 0 && <p className="rounded-lg bg-yellow/10 px-3 py-2 text-sm text-yellow">{label('decks.unavailableAfterAllocations', { count: deck.shared_missing_copy_count })}</p>}

      <div className="inline-flex rounded-full bg-fill-tertiary p-0.5" role="tablist"><button type="button" role="tab" aria-selected={view === 'editor'} className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${view === 'editor' ? 'bg-brand-red text-white shadow' : 'text-text-secondary hover:text-text-primary'}`} onClick={() => setView('editor')}>{t('decks.editor')}</button><button type="button" role="tab" aria-selected={view === 'analytics'} className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${view === 'analytics' ? 'bg-brand-red text-white shadow' : 'text-text-secondary hover:text-text-primary'}`} onClick={() => setView('analytics')}>{t('decks.analytics')}</button></div>

      {view === 'analytics' ? <DeckAnalyticsPanel analysis={deck.analysis} deckId={deckId} entries={entries} t={t} /> : <div className="space-y-3">
        <CardListPicker
          key={deck.binder_type}
          open={pickerOpen}
          title={t('decks.addCards')}
          collection={collection}
          existingCardIds={entries.map(entry => entry.card_id || entry.card?.id)}
          selectionMode="card"
          allowCatalog={!isRealDeck}
          limitOwnedQuantity={isRealDeck}
          maximumQuantityField={isRealDeck ? 'available_quantity' : undefined}
          unavailableReason={isRealDeck ? t('decks.noFreeCopies') : undefined}
          onSubmit={items => addEntriesMutation.mutateAsync(items)}
          isSubmitting={addEntriesMutation.isPending}
          onOpenChange={setDeckPickerOpen}
          sectionId="deck-owned-cards-content"
          t={t}
          label={label}
        />
        <section className="space-y-3">
           <DeckCompositionBar entries={entries} progress={progress} t={t} label={label} />
           <DeckValidationPanel validation={deck.validation} t={t} />
          {entries.length === 0 ? (
            <div className="card py-14 text-center text-sm text-text-muted">{t('decks.emptyDeck')}</div>
          ) : (
            <CardListGallery
              entries={entries}
              mode={isRealDeck ? 'physical' : 'planned'}
              onOpen={(_entry, index) => setViewerIndex(index)}
              t={t}
              label={label}
              formatPrice={formatPrice}
              pricePrimaryField={pricePrimaryField}
            />
          )}
        </section>
      </div>}

      <DeckCardViewer
        entries={entries}
        activeIndex={viewerIndex}
        onClose={() => setViewerIndex(null)}
        onPrevious={previousCard}
        onNext={nextCard}
        onQuantityChange={(entry, delta) => changeQuantity(entry.id, entry.required_quantity, delta)}
        onRemove={entry => { setViewerIndex(null); removeMutation.mutate(entry.id) }}
        pendingEntryIds={pendingEntryIds}
        isRemoving={removeMutation.isPending}
        t={t}
        label={label}
        equivalentPrints={equivalentPrints?.equivalents || []}
        equivalentPrintsLoading={equivalentPrintsLoading}
        onSwitchPrint={cardId => switchPrintMutation.mutate(cardId)}
        isSwitchingPrint={switchPrintMutation.isPending}
        isRealDeck={isRealDeck}
      />
      {showCsvImportModal && <BinderCsvImportModal t={t} listType="deck" onClose={() => setShowCsvImportModal(false)} onChooseFile={() => csvInputRef.current?.click()} isImporting={importMutation.isPending} />}
    </div>
  )
}
