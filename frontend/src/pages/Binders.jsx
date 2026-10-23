import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Plus, Trash2, Edit2, BookOpen, Star, Package, PackageCheck, Check, X, Globe, Copy, Layers3, MoreHorizontal, ChevronRight } from 'lucide-react'
import { getBinders, createBinder, updateBinder, updateDeck, deleteBinder, getProfile } from '../api/client'
import { useSettings } from '../contexts/SettingsContext'
import { useConfirmDialog } from '../contexts/ConfirmDialogContext'
import CollectionHeader from '../components/collection/CollectionHeader'
import IconButton from '../components/ios/IconButton'
import ListSection from '../components/ios/ListSection'
import Menu from '../components/ios/Menu'
import PageSheet from '../components/ios/PageSheet'
import { useNavBar } from '../navigation/useNavBar'
import AvatarPicker from '../components/AvatarPicker'
import toast from 'react-hot-toast'
import { invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'

const SPRITE_BASE_URL = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated'

const BINDER_COLORS = [
  '#EF1515', '#3b82f6', '#22c55e', '#eab308', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16',
]
const FORMAT_OPTIONS = ['Standard', 'Expanded', 'Unlimited', 'Casual']

function BinderForm({ initial = {}, onSubmit, onCancel, loading }) {
  const { t } = useSettings()
  const isEditing = Boolean(initial.id)
  const [name, setName] = useState(initial.name || '')
  const [desc, setDesc] = useState(initial.description || '')
  const [color, setColor] = useState(initial.color || '#EF1515')
  const [binderType, setBinderType] = useState(initial.binder_type || 'collection')
  const [format, setFormat] = useState(initial.format || '')
  const [targetSize, setTargetSize] = useState(initial.target_size || 60)
  const [iconPokemonId, setIconPokemonId] = useState(initial.icon_pokemon_id || null)
  const [showIconPicker, setShowIconPicker] = useState(false)

  return (
    <div className="space-y-3">
      <input type="text" maxLength={255} placeholder={t('binders.cardListName')} value={name}
        onChange={(e) => setName(e.target.value)} className="input" autoFocus />
      <input type="text" placeholder={t('binders.description')} value={desc}
        onChange={(e) => setDesc(e.target.value)} className="input" />

      {(!isEditing || initial.binder_type !== 'collection') && <div>
        <label className="text-xs text-text-muted mb-2 block">{t('binderTypes.typeLabel')}</label>
        <div className={`grid gap-2 ${isEditing ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-4'}`}>
          {!isEditing && <button type="button" onClick={() => setBinderType('collection')}
            className={`flex-1 py-2.5 px-3 rounded-lg border text-sm font-medium transition-all flex items-center justify-center gap-2 ${
              binderType === 'collection'
                ? 'bg-blue/20 border-blue text-blue'
                : 'bg-bg-card border-border text-text-muted hover:border-text-muted'
            }`}>
            <Package size={16} /> {t('binderTypes.collection')}
          </button>}
          <button type="button" onClick={() => setBinderType('wishlist')}
            className={`flex-1 py-2.5 px-3 rounded-lg border text-sm font-medium transition-all flex items-center justify-center gap-2 ${
              binderType === 'wishlist'
                ? 'bg-yellow/20 border-yellow text-yellow'
                : 'bg-bg-card border-border text-text-muted hover:border-text-muted'
            }`}>
            <Star size={16} /> {t('binderTypes.planned')}
          </button>
          <button type="button" onClick={() => setBinderType('deck')}
            className={`flex-1 py-2.5 px-3 rounded-lg border text-sm font-medium transition-all flex items-center justify-center gap-2 ${
              binderType === 'deck'
                ? 'bg-purple-500/20 border-purple-400 text-purple-300'
                : 'bg-bg-card border-border text-text-muted hover:border-text-muted'
            }`}>
            <Layers3 size={16} /> {t('binderTypes.plannedDeck')}
          </button>
          {!isEditing && <button type="button" onClick={() => setBinderType('physical_deck')}
            className={`flex-1 py-2.5 px-3 rounded-lg border text-sm font-medium transition-all flex items-center justify-center gap-2 ${
              binderType === 'physical_deck'
                ? 'bg-green/20 border-green text-green'
                : 'bg-bg-card border-border text-text-muted hover:border-text-muted'
            }`}>
            <PackageCheck size={16} /> {t('binderTypes.realDeck')}
          </button>}
        </div>
        <p className="text-xs text-text-muted mt-1.5">
          {binderType === 'collection'
            ? t('binderTypes.collectionDesc')
            : binderType === 'deck'
              ? t('binderTypes.plannedDeckDesc')
              : binderType === 'physical_deck'
                ? t('binderTypes.realDeckDesc')
              : t('binderTypes.plannedDesc')}
        </p>
      </div>}

      {['deck', 'physical_deck'].includes(binderType) && <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="text-xs text-text-muted mb-2 block">{t('binderTypes.format')}</label>
          <select value={format || 'Casual'} onChange={(e) => setFormat(e.target.value)} className="select">
            {FORMAT_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
          <p className="text-xs text-text-muted mt-1.5">{t('binderTypes.deckFormatHint')}</p>
        </div>
        <div>
          <label className="text-xs text-text-muted mb-2 block">{t('decks.target')}</label>
          <select value={targetSize} onChange={(e) => setTargetSize(Number(e.target.value))} className="select">
            {[20, 40, 60].map(size => <option key={size} value={size}>{size}</option>)}
          </select>
          <p className="text-xs text-text-muted mt-1.5">{t('binderTypes.deckSizeHint')}</p>
        </div>
      </div>}

      <div>
        <label className="text-xs text-text-muted mb-2 block">{t('binders.color')}</label>
        <div className="flex gap-2">
          {BINDER_COLORS.map((c) => (
            <button key={c} type="button"
              className={`w-6 h-6 rounded-full border-2 transition-all ${
                color === c ? 'border-white scale-110' : 'border-transparent hover:scale-110'
              }`}
              style={{ backgroundColor: c }}
              onClick={() => setColor(c)} />
          ))}
        </div>
      </div>

      <div>
        <label className="text-xs text-text-muted mb-2 block">{t('binders.icon')}</label>
        <div className="rounded-xl border border-border bg-bg-card p-4">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setShowIconPicker(true)}
              className="w-24 h-24 rounded-2xl border border-border bg-bg-surface flex items-center justify-center flex-shrink-0 hover:border-brand-red/50 transition-colors"
              aria-label={t('binders.chooseIcon')}
              title={t('binders.chooseIcon')}
            >
              {iconPokemonId ? (
                <img src={`${SPRITE_BASE_URL}/${iconPokemonId}.gif`} alt={`Pokemon ${iconPokemonId}`} className="max-h-20 max-w-full object-contain pixelated" />
              ) : (
                <BookOpen size={32} style={{ color }} />
              )}
            </button>
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium text-text-primary">{t('binders.chooseIcon')}</p>
              <p className="text-xs text-text-muted">{t('binders.iconHint')}</p>
              {iconPokemonId && (
                <button type="button" onClick={() => setIconPokemonId(null)} className="text-xs text-text-muted hover:text-brand-red">
                  {t('binders.clearIcon')}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={() => onSubmit({
          name: name.trim(),
          description: desc,
          color,
          ...((!isEditing || initial.binder_type !== 'collection') && { binder_type: binderType }),
          format: ['deck', 'physical_deck'].includes(binderType) ? (format || 'Casual') : null,
          target_size: ['deck', 'physical_deck'].includes(binderType) ? targetSize : null,
          icon_pokemon_id: iconPokemonId,
        })}
          disabled={!name.trim() || loading} className="btn-primary flex-1">
          <Check size={14} /> {loading ? t('common.saving') : t('common.save')}
        </button>
        <button onClick={onCancel} className="btn-ghost">
          <X size={14} /> {t('common.cancel')}
        </button>
      </div>
      <AvatarPicker
        isOpen={showIconPicker}
        onClose={() => setShowIconPicker(false)}
        onSelect={(pokemonId) => setIconPokemonId(pokemonId)}
        currentAvatarId={iconPokemonId}
        title={t('binders.chooseIcon')}
      />
    </div>
  )
}

export default function Binders() {
  const { t } = useSettings()
  const confirmDialog = useConfirmDialog()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [editingBinder, setEditingBinder] = useState(null)
  const { data: binderData = [], isLoading } = useQuery({
    queryKey: ['binders'],
    queryFn: () => getBinders().then(r => r.data),
  })

  const { data: profileData } = useQuery({
    queryKey: ['profile'],
    queryFn: () => getProfile(),
    staleTime: 60000,
  })
  const profileIsPublic = !!profileData?.is_profile_public
  const publicHandle = profileData?.public_handle
  const publicProfilesEnabled = !!profileData?.feature_enabled
  const binders = Array.isArray(binderData) ? binderData : []

  // "+" is the one create action of this page: it opens the form, which picks the list type.
  const navOptions = useMemo(() => ({
    title: t('nav.collection'),
    trailing: (
      <IconButton icon={Plus} label={t('binders.newCardList')} onClick={() => setCreating(true)} />
    ),
  }), [t])
  useNavBar(navOptions)

  const createMutation = useMutation({
    mutationFn: createBinder,
    onSuccess: () => {
      toast.success(t('binders.created'))
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      queryClient.invalidateQueries({ queryKey: ['decks'] })
      invalidateTcgdexFilterLanguages(queryClient)
      setCreating(false)
    },
    onError: () => toast.error(t('binders.createFailed')),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => updateBinder(id, data),
    onSuccess: () => {
      toast.success(t('binders.updated'))
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      queryClient.invalidateQueries({ queryKey: ['decks'] })
      invalidateTcgdexFilterLanguages(queryClient)
      setEditingBinder(null)
    },
    onError: (error) => toast.error(error.response?.data?.detail || t('binders.updateFailed')),
  })

  const deleteMutation = useMutation({
    mutationFn: deleteBinder,
    onSuccess: () => {
      toast.success(t('binders.deleted'))
      queryClient.invalidateQueries({ queryKey: ['binders'] })
      queryClient.invalidateQueries({ queryKey: ['decks'] })
      invalidateTcgdexFilterLanguages(queryClient)
    },
  })

  const publicToggleMutation = useMutation({
    mutationFn: ({ id, is_public, isDeck }) => isDeck
      ? updateDeck(id, { is_public })
      : updateBinder(id, { is_public }),
    onSuccess: () => {
      toast.success(t('binders.publicUpdated'))
      queryClient.invalidateQueries({ queryKey: ['binders'] })
    },
    onError: (error) => toast.error(error.response?.data?.detail || t('binders.updateFailed')),
  })

  const copyPublicBinderLink = async (binderId, isDeck = false) => {
    const url = `${window.location.origin}/u/${publicHandle}/${isDeck ? 'deck' : 'binder'}/${binderId}`
    try {
      await navigator.clipboard.writeText(url)
      toast.success(t('settings.linkCopied'))
    } catch {
      toast.error(t('settings.linkCopyFailed'))
    }
  }

  const canShare = (binder) => binder.binder_type !== 'wishlist' && publicProfilesEnabled
  const showShareHint = publicProfilesEnabled && !profileIsPublic && binders.some(canShare)

  const rowMenuSections = (binder, isDeck) => {
    const sections = [[
      { id: 'edit', label: t('common.edit'), icon: Edit2, onSelect: () => setEditingBinder(binder) },
    ]]
    if (canShare(binder) && profileIsPublic) {
      const share = [{
        id: 'public',
        label: t('binders.sharePublicly'),
        checked: !!binder.is_public,
        disabled: publicToggleMutation.isPending,
        onSelect: () => publicToggleMutation.mutate({ id: binder.id, is_public: !binder.is_public, isDeck }),
      }]
      if (binder.is_public && publicHandle) {
        share.push({ id: 'link', label: t('binders.copyPublicLink'), icon: Copy, onSelect: () => copyPublicBinderLink(binder.id, isDeck) })
      }
      sections.push(share)
    }
    sections.push([{
      id: 'delete',
      label: t('common.delete'),
      icon: Trash2,
      destructive: true,
      onSelect: async () => {
        const confirmed = await confirmDialog({
          title: t('common.delete'),
          message: t('binders.deleteConfirm').replace('{name}', binder.name),
          confirmLabel: t('common.delete'),
          destructive: true,
        })
        if (confirmed) deleteMutation.mutate(binder.id)
      },
    }])
    return sections
  }

  return (
    <div className="relative isolate space-y-4 pb-2">
      <CollectionHeader active="lists" subtitle={t('binders.subtitle')} />

      {isLoading ? (
        <div className="space-y-2">
          {[...Array(4)].map((_, i) => <div key={i} className="skeleton h-16 rounded-xl" />)}
        </div>
      ) : binders.length === 0 ? (
        <div className="card text-center py-20">
          <BookOpen size={48} className="mx-auto mb-4 text-text-muted" />
          <p className="text-text-muted">{t('binders.empty')}</p>
          <p className="text-xs text-text-muted mt-1">{t('binders.emptyHint')}</p>
          <button onClick={() => setCreating(true)} className="btn-primary mt-4 mx-auto w-fit">
            <Plus size={16} /> {t('binders.createFirst')}
          </button>
        </div>
      ) : (
        <div className="-mx-4 sm:-mx-4">
          <ListSection header={t('binders.title')} footer={showShareHint ? t('binders.enablePublicProfileHint') : undefined}>
            {binders.map((binder) => {
              const isWishlist = binder.binder_type === 'wishlist'
              const isPlannedDeck = binder.binder_type === 'deck'
              const isRealDeck = binder.binder_type === 'physical_deck'
              const isDeck = isPlannedDeck || isRealDeck
              const TypeIcon = isRealDeck ? PackageCheck : isPlannedDeck ? Layers3 : isWishlist ? Star : BookOpen
              const totalCount = binder.card_count || 0
              const uniqueCount = binder.unique_card_count || 0
              const showUniqueCount = uniqueCount > 0 && uniqueCount !== totalCount
              const typeLabel = isRealDeck ? t('binderTypes.realDeck') : isPlannedDeck ? t('binderTypes.plannedDeck') : isWishlist ? t('binderTypes.planned') : t('binderTypes.collection')
              const typeTone = isRealDeck ? 'text-green' : isPlannedDeck ? 'text-purple-300' : isWishlist ? 'text-yellow' : 'text-blue'
              return (
                <div
                  key={binder.id}
                  data-testid="card-list-row"
                  className="relative flex items-center after:pointer-events-none after:absolute after:bottom-0 after:left-[68px] after:right-0 after:h-[0.5px] after:bg-border last:after:hidden"
                >
                  <Link
                    to={isDeck ? `/decks/${binder.id}` : `/binders/${binder.id}`}
                    className="ios-press flex min-h-[64px] min-w-0 flex-1 items-center gap-3 py-2.5 pl-4 pr-1 text-left"
                  >
                    <span
                      className="grid h-11 w-11 flex-shrink-0 place-items-center overflow-hidden rounded-[11px]"
                      style={{ background: `color-mix(in srgb, ${binder.color || '#EF1515'} 28%, #000)` }}
                    >
                      {binder.icon_pokemon_id ? (
                        <img src={`${SPRITE_BASE_URL}/${binder.icon_pokemon_id}.gif`} alt="" className="max-h-9 max-w-9 object-contain pixelated" loading="lazy" />
                      ) : (
                        <TypeIcon size={22} style={{ color: binder.color }} aria-hidden="true" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <h3 className="break-words text-body font-medium text-text-primary">{binder.name}</h3>
                      <span className={`flex items-center gap-1 text-footnote ${typeTone}`}>
                        <TypeIcon size={11} aria-hidden="true" /><span>{typeLabel}</span>
                      </span>
                      {isDeck && (
                        <span className="block break-words text-footnote text-text-secondary">{t(`decks.format${binder.format || 'Casual'}`)} · {binder.target_size || 60} {t('binders.cards')}</span>
                      )}
                      {binder.description && (
                        <span className="block break-words text-footnote text-text-secondary">{binder.description}</span>
                      )}
                      <span className="block text-footnote text-text-secondary">
                        {totalCount} {totalCount === 1 ? t('binders.card') : t('binders.cards')}
                        {showUniqueCount && <> · {uniqueCount} {uniqueCount === 1 ? t('binders.uniqueCard') : t('binders.uniqueCards')}</>}
                      </span>
                    </span>
                    {binder.is_public && !isWishlist && <Globe size={14} className="flex-shrink-0 text-green" aria-hidden="true" />}
                    <ChevronRight size={18} strokeWidth={2.25} className="flex-shrink-0 text-text-tertiary" aria-hidden="true" />
                  </Link>
                  <Menu
                    label={`${t('binders.actionsLabel')}: ${binder.name}`}
                    sections={rowMenuSections(binder, isDeck)}
                    trigger={(
                      <IconButton
                        icon={MoreHorizontal}
                        variant="plain"
                        size="sm"
                        label={`${t('binders.actionsLabel')}: ${binder.name}`}
                        className="mr-2 text-text-secondary"
                      />
                    )}
                  />
                </div>
              )
            })}
          </ListSection>
        </div>
      )}

      <PageSheet
        isOpen={creating}
        onClose={() => setCreating(false)}
        title={t('binders.createCardList')}
      >
        <div className="p-4">
          <BinderForm onSubmit={(data) => createMutation.mutate(data)} onCancel={() => setCreating(false)} loading={createMutation.isPending} />
        </div>
      </PageSheet>

      <PageSheet
        isOpen={Boolean(editingBinder)}
        onClose={() => setEditingBinder(null)}
        title={t('binders.editSheetTitle')}
      >
        {editingBinder && (
          <div className="p-4">
            <BinderForm
              key={editingBinder.id}
              initial={editingBinder}
              onSubmit={(data) => updateMutation.mutate({ id: editingBinder.id, data })}
              onCancel={() => setEditingBinder(null)}
              loading={updateMutation.isPending}
            />
          </div>
        )}
      </PageSheet>
    </div>
  )
}
