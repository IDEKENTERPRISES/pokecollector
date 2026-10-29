import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import toast from 'react-hot-toast'
import { getCollection, putShowcase } from '../api/client'
import PageSheet from '../components/ios/PageSheet'
import { useSettings } from '../contexts/SettingsContext'
import { useOffline } from '../offline/useOffline'
import { SHOWCASE_MAX, fill, showcaseChanged, toggleShowcase } from './delights'

const imageFor = cardId => `/api/images/card/${encodeURIComponent(cardId)}/small`

/** The Profile's Showcase 6 picker: choose up to six owned copies; the order picked is the order shown. */
export default function ShowcasePicker({ isOpen, onClose, saved }) {
  const { t } = useSettings()
  const offline = useOffline()
  const queryClient = useQueryClient()
  const [picked, setPicked] = useState(saved)
  const [search, setSearch] = useState('')

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['collection', {}],
    queryFn: () => getCollection({}).then(r => r.data),
    enabled: isOpen,
  })
  const save = useMutation({
    mutationFn: () => putShowcase(picked),
    onSuccess: (data) => {
      queryClient.setQueryData(['showcase'], data)
      toast.success(t('delights.showcaseSaved'))
      onClose()
    },
    onError: () => toast.error(t('delights.showcaseSaveFailed')),
  })

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return items
      .filter(item => item.card && !item.card.is_custom)
      .filter(item => !needle || String(item.card.name ?? '').toLowerCase().includes(needle))
      .slice(0, 200)
  }, [items, search])

  const full = picked.length >= SHOWCASE_MAX
  const dirty = showcaseChanged(saved, picked)

  return (
    <PageSheet
      isOpen={isOpen}
      onClose={onClose}
      title={t('delights.showcasePickerTitle')}
      isDirty={dirty}
      trailing={{ label: t('ios.done'), onPress: () => save.mutate(), disabled: !dirty || save.isPending || offline }}
    >
      <div className="space-y-3 p-4" data-testid="showcase-picker">
        <input
          type="search"
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder={t('delights.showcaseSearch')}
          aria-label={t('delights.showcaseSearch')}
          className="min-h-[44px] w-full rounded-xl bg-fill-tertiary px-3 text-body text-text-primary"
        />
        <p className="text-footnote text-text-secondary" aria-live="polite" data-testid="showcase-count">
          {fill(t('delights.showcasePicked'), { count: picked.length, max: SHOWCASE_MAX })}
          {full ? ` · ${t('delights.showcaseFull')}` : ''}
        </p>
        {offline && <p className="text-footnote text-yellow">{t('delights.showcaseOffline')}</p>}
        {isLoading && <p className="text-body text-text-secondary">{t('delights.showcaseLoading')}</p>}
        {!isLoading && rows.length === 0 && <p className="text-body text-text-secondary">{t('delights.showcaseNone')}</p>}
        <ul className="grid grid-cols-3 gap-2">
          {rows.map(item => {
            const on = picked.includes(item.id)
            return (
              <li key={item.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  disabled={!on && full}
                  onClick={() => setPicked(current => toggleShowcase(current, item.id))}
                  data-testid="showcase-option"
                  className="ios-press relative block min-h-[44px] w-full rounded-lg text-left disabled:opacity-40"
                >
                  <img
                    src={imageFor(item.card_id ?? item.card.id)}
                    alt={item.card.name}
                    loading="lazy"
                    className={`aspect-[5/7] w-full rounded-md bg-fill-tertiary object-cover ${on ? 'ring-2 ring-tint' : ''}`}
                  />
                  {on && (
                    <span className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-tint text-on-accent" aria-hidden="true">
                      <Check size={14} strokeWidth={3} />
                    </span>
                  )}
                  <span className="mt-1 block truncate text-caption-1 text-text-secondary">{item.card.name}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </PageSheet>
  )
}
