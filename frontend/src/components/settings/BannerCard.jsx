import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import toast from 'react-hot-toast'
import { getUsers } from '../../api/client'
import { createBanner, deleteBanner, endBanner, getAdminBanners, updateBanner } from '../../api/banners'
import { useAuth } from '../../contexts/AuthContext'
import { useSettings } from '../../contexts/SettingsContext'
import AvatarPicker from '../AvatarPicker'
import SegmentedControl from '../ios/SegmentedControl'
import BannerView, { BANNER_STYLES, spriteUrl } from '../banners/BannerView'
import { ACTIVE_BANNERS_QUERY_KEY } from '../banners/HomeBanners'
import { ANNOUNCEMENT_ROUTES } from './SendNotificationCard'

export const MAX_MESSAGE = 280
export const MAX_NAME = 40

/** A blank form; the sender name starts as the admin's own username. */
export const emptyForm = user => ({
  message: '', senderName: user?.username || '', avatarMode: 'me', avatarId: null,
  style: 'info', route: '', audience: 'all', chosen: [], endsAt: '', dismissible: true,
})

const clean = text => String(text ?? '').split(/\s+/).filter(Boolean).join(' ')

/** True when the form may be saved. */
export function canSave(form) {
  const message = clean(form.message)
  if (!message || message.length > MAX_MESSAGE) return false
  const name = clean(form.senderName)
  if (!name || name.length > MAX_NAME) return false
  if (form.avatarMode === 'pokemon' && !(form.avatarId >= 1 && form.avatarId <= 151)) return false
  if (form.audience === 'some' && form.chosen.length === 0) return false
  return true
}

/** The body of the create/update call. */
export function buildPayload(form) {
  return {
    message: clean(form.message),
    sender_name: clean(form.senderName),
    avatar_mode: form.avatarMode,
    avatar_id: form.avatarMode === 'pokemon' ? form.avatarId : null,
    style: form.style,
    route: form.route || null,
    audience: form.audience,
    user_ids: form.audience === 'some' ? form.chosen : [],
    ends_at: form.endsAt ? new Date(form.endsAt).toISOString() : null,
    dismissible: form.dismissible,
  }
}

const pad = n => String(n).padStart(2, '0')

/** An ISO time as the local `YYYY-MM-DDTHH:mm` a datetime-local input wants. */
export function toLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The form for an existing banner. */
export function formFromBanner(banner) {
  return {
    message: banner.message,
    senderName: banner.sender_name,
    avatarMode: banner.avatar_mode,
    avatarId: banner.avatar_mode === 'pokemon' ? banner.avatar_id : null,
    style: banner.style,
    route: banner.route || '',
    audience: banner.audience,
    chosen: banner.user_ids || [],
    endsAt: toLocalInput(banner.ends_at),
    dismissible: banner.dismissible,
  }
}

/** The card as trainers will see it, for the live preview. */
export function previewBanner(form, user) {
  return {
    id: 0,
    label: clean(form.senderName) === user?.username ? 'admin' : 'system',
    sender_name: clean(form.senderName) || '...',
    avatar_id: form.avatarMode === 'pokemon' ? form.avatarId : user?.avatar_id ?? null,
    message: clean(form.message) || '...',
    style: form.style,
    route: form.route || null,
    dismissible: form.dismissible,
  }
}

function whenText(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : format(date, 'd MMM yyyy, HH:mm')
}

export function BannerList({ entries, t, onEdit, onEnd, onDelete }) {
  if (!entries.length) return <p className="px-4 py-3 text-footnote text-text-secondary">{t('banners.listEmpty')}</p>
  return (
    <ul className="divide-y-[0.5px] divide-border" data-testid="banner-admin-list">
      {entries.map(entry => (
        <li key={entry.id} className="space-y-1.5 px-4 py-3" data-testid="banner-admin-entry" data-status={entry.status}>
          <div className="flex items-start gap-2">
            {spriteUrl(entry.avatar_id) && <img src={spriteUrl(entry.avatar_id)} alt="" className="pixelated h-8 w-8 flex-shrink-0" />}
            <div className="min-w-0 flex-1">
              <p className="text-body font-semibold" style={{ overflowWrap: 'anywhere' }}>{entry.sender_name}</p>
              <p className="text-footnote text-text-secondary" style={{ overflowWrap: 'anywhere' }}>{entry.message}</p>
              <p className="text-caption-1 text-text-muted">
                {t(`banners.status.${entry.status}`)}
                {entry.ends_at ? ` · ${t('banners.until')} ${whenText(entry.ends_at)}` : ''}
                {' · '}{entry.audience === 'all' ? t('banners.everyone') : t('banners.someTrainers').replace('{count}', entry.user_ids.length)}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-secondary min-h-[44px]" data-testid="banner-edit" onClick={() => onEdit(entry)}>{t('banners.edit')}</button>
            {entry.status === 'active' && (
              <button type="button" className="btn-secondary min-h-[44px]" data-testid="banner-end" onClick={() => onEnd(entry)}>{t('banners.endNow')}</button>
            )}
            <button type="button" className="btn-secondary min-h-[44px] text-red-500" data-testid="banner-delete" onClick={() => onDelete(entry)}>{t('banners.delete')}</button>
          </div>
        </li>
      ))}
    </ul>
  )
}

export default function BannerCard() {
  const { t } = useSettings()
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [form, setForm] = useState(() => emptyForm(user))
  const [editingId, setEditingId] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [deleting, setDeleting] = useState(null)

  const { data: allUsers = [] } = useQuery({ queryKey: ['users'], queryFn: getUsers })
  const users = allUsers.filter(u => u.is_active !== false)
  const list = useQuery({ queryKey: ['admin-banners'], queryFn: getAdminBanners })

  const set = patch => setForm(current => ({ ...current, ...patch }))
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-banners'] })
    queryClient.invalidateQueries({ queryKey: ACTIVE_BANNERS_QUERY_KEY })
    queryClient.invalidateQueries({ queryKey: ['audit-log'] })
  }
  const onError = error => {
    const detail = error?.response?.data?.detail
    toast.error(typeof detail === 'string' ? detail : t('banners.failed'))
  }

  const save = useMutation({
    mutationFn: () => (editingId ? updateBanner(editingId, buildPayload(form)) : createBanner(buildPayload(form))),
    onSuccess: () => {
      toast.success(t(editingId ? 'banners.saved' : 'banners.created'))
      setForm(emptyForm(user))
      setEditingId(null)
      refresh()
    },
    onError,
  })
  const end = useMutation({ mutationFn: entry => endBanner(entry.id), onSuccess: () => { toast.success(t('banners.ended')); refresh() }, onError })
  const remove = useMutation({
    mutationFn: entry => deleteBanner(entry.id),
    onSuccess: () => { toast.success(t('banners.deleted')); setDeleting(null); refresh() },
    onError,
  })

  const toggle = id => set({ chosen: form.chosen.includes(id) ? form.chosen.filter(x => x !== id) : [...form.chosen, id] })
  const ready = canSave(form)

  return (
    <section className="space-y-1" data-testid="banner-card">
      <h2 className="px-4 pb-1.5 text-footnote text-text-secondary">{t('banners.title')}</h2>
      <div className="space-y-4 overflow-hidden rounded-xl bg-card p-4">
        <p className="text-footnote text-text-secondary">{t(editingId ? 'banners.editing' : 'banners.intro')}</p>

        <label className="block space-y-1">
          <span className="text-subheadline font-semibold">{t('banners.messageLabel')}</span>
          <textarea
            className="input w-full" rows={3} value={form.message} maxLength={MAX_MESSAGE} data-testid="banner-message-input"
            onChange={event => set({ message: event.target.value })}
          />
          <span className="block text-right text-caption-1 text-text-muted" data-testid="banner-counter">{form.message.length}/{MAX_MESSAGE}</span>
        </label>

        <label className="block space-y-1">
          <span className="text-subheadline font-semibold">{t('banners.senderLabel')}</span>
          <input
            className="input w-full" value={form.senderName} maxLength={MAX_NAME} placeholder={t('banners.senderPlaceholder')}
            data-testid="banner-name-input" onChange={event => set({ senderName: event.target.value })}
          />
          <span className="block text-right text-caption-1 text-text-muted" data-testid="banner-name-counter">{form.senderName.length}/{MAX_NAME}</span>
        </label>

        <div className="space-y-2">
          <span className="text-subheadline font-semibold">{t('banners.pictureLabel')}</span>
          <SegmentedControl
            ariaLabel={t('banners.pictureLabel')} value={form.avatarMode} onChange={value => set({ avatarMode: value })}
            options={[
              { value: 'me', label: t('banners.pictureMe') },
              { value: 'pokemon', label: t('banners.picturePokemon') },
            ]}
          />
          {form.avatarMode === 'pokemon' && (
            <button type="button" className="btn-secondary min-h-[44px]" data-testid="banner-pick" onClick={() => setPickerOpen(true)}>
              {form.avatarId ? <img src={spriteUrl(form.avatarId)} alt="" className="pixelated mr-2 h-8 w-8" /> : null}
              {t(form.avatarId ? 'banners.changePokemon' : 'banners.pickPokemon')}
            </button>
          )}
          <AvatarPicker
            isOpen={pickerOpen} onClose={() => setPickerOpen(false)} currentAvatarId={form.avatarId}
            onSelect={id => set({ avatarId: id })} title={t('banners.pickPokemon')}
          />
        </div>

        <div className="space-y-2">
          <span className="text-subheadline font-semibold">{t('banners.styleLabel')}</span>
          <SegmentedControl
            ariaLabel={t('banners.styleLabel')} value={form.style} onChange={value => set({ style: value })}
            options={BANNER_STYLES.map(value => ({ value, label: t(`banners.styles.${value}`) }))}
          />
        </div>

        <label className="block space-y-1">
          <span className="text-subheadline font-semibold">{t('banners.opensLabel')}</span>
          <select className="select w-full text-body" value={form.route} data-testid="banner-route" onChange={event => set({ route: event.target.value })}>
            <option value="">{t('banners.opensNothing')}</option>
            {ANNOUNCEMENT_ROUTES.map(option => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}
          </select>
        </label>

        <div className="space-y-2">
          <span className="text-subheadline font-semibold">{t('banners.audienceLabel')}</span>
          <SegmentedControl
            ariaLabel={t('banners.audienceLabel')} value={form.audience} onChange={value => set({ audience: value })}
            options={[{ value: 'all', label: t('banners.everyone') }, { value: 'some', label: t('banners.chooseTrainers') }]}
          />
          {form.audience === 'some' && (
            <ul className="max-h-56 overflow-y-auto rounded-lg border-[0.5px] border-border" data-testid="banner-trainers">
              {users.map(u => (
                <li key={u.id} className="border-t-[0.5px] border-border first:border-t-0">
                  <label className="flex min-h-[44px] items-center gap-3 px-3">
                    <input type="checkbox" checked={form.chosen.includes(u.id)} onChange={() => toggle(u.id)} />
                    <span className="text-body">{u.username}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <label className="block space-y-1">
          <span className="text-subheadline font-semibold">{t('banners.endsLabel')}</span>
          <input
            type="datetime-local" className="input w-full" value={form.endsAt} data-testid="banner-ends"
            onChange={event => set({ endsAt: event.target.value })}
          />
          <span className="block text-caption-1 text-text-muted">{t('banners.endsHint')}</span>
        </label>

        <label className="flex min-h-[44px] items-center gap-3">
          <input type="checkbox" checked={form.dismissible} data-testid="banner-dismissible" onChange={event => set({ dismissible: event.target.checked })} />
          <span className="text-body">{t('banners.dismissibleLabel')}</span>
        </label>

        <div className="space-y-1">
          <span className="text-subheadline font-semibold">{t('banners.previewLabel')}</span>
          <BannerView banner={previewBanner(form, user)} interactive={false} testId="banner-preview" />
        </div>

        <div className="flex gap-3">
          {editingId && (
            <button type="button" className="btn-secondary flex-1 justify-center" onClick={() => { setForm(emptyForm(user)); setEditingId(null) }}>
              {t('banners.cancelEdit')}
            </button>
          )}
          <button
            type="button" className="btn-primary flex-1 justify-center" disabled={!ready || save.isPending}
            data-testid="banner-save" onClick={() => save.mutate()}
          >
            {t(editingId ? 'banners.saveChanges' : 'banners.publish')}
          </button>
        </div>
      </div>

      <h2 className="px-4 pb-1.5 pt-4 text-footnote text-text-secondary">{t('banners.listTitle')}</h2>
      <div className="overflow-hidden rounded-xl bg-card">
        <BannerList
          entries={list.data?.entries ?? []} t={t}
          onEdit={entry => { setForm(formFromBanner(entry)); setEditingId(entry.id); window.scrollTo?.({ top: 0, behavior: 'smooth' }) }}
          onEnd={entry => end.mutate(entry)}
          onDelete={entry => setDeleting(entry)}
        />
      </div>

      {deleting && (
        <div className="space-y-3 rounded-xl bg-card p-4" data-testid="banner-delete-confirm">
          <p className="text-subheadline">{t('banners.deleteConfirm')}</p>
          <div className="flex gap-3">
            <button type="button" className="btn-secondary flex-1 justify-center" onClick={() => setDeleting(null)}>{t('banners.cancelEdit')}</button>
            <button type="button" className="btn-primary flex-1 justify-center" data-testid="banner-delete-yes" disabled={remove.isPending} onClick={() => remove.mutate(deleting)}>
              {t('banners.delete')}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
