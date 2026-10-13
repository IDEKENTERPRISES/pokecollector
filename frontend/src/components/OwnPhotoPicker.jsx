import { useEffect, useId, useState } from 'react'
import { ImagePlus, Loader2, Trash2 } from 'lucide-react'

import { useSettings } from '../contexts/SettingsContext'

// "My card photo" field for the add-to-collection forms: shows the photo that
// will be saved with the card and lets the user drop it, or pick their own.
// `photo` is a Blob/File (or null); the parent uploads it once the item exists.
export default function OwnPhotoPicker({ photo, loading = false, hint, onChange, disabled = false }) {
  const { t } = useSettings()
  const inputId = useId()
  const [previewUrl, setPreviewUrl] = useState(null)

  useEffect(() => {
    if (!photo) {
      setPreviewUrl(null)
      return undefined
    }
    const url = URL.createObjectURL(photo)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [photo])

  return (
    <div>
      <label className="text-xs text-text-muted mb-1 block font-medium">{t('collection.ownPhotoLabel')}</label>
      <div className="flex items-center gap-3 rounded-xl border border-border bg-bg-card p-2.5">
        <div className="grid h-20 w-14 flex-shrink-0 place-items-center overflow-hidden rounded-md border border-white/10 bg-bg-surface">
          {loading ? (
            <Loader2 size={18} className="animate-spin text-text-muted" aria-label={t('collection.ownPhotoLoading')} />
          ) : previewUrl ? (
            <img src={previewUrl} alt={t('collection.ownPhotoLabel')} className="h-full w-full object-cover" />
          ) : (
            <ImagePlus size={18} className="text-text-muted" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          {hint && <p className="text-[11px] leading-snug text-text-secondary">{hint}</p>}
          <input
            id={inputId}
            type="file"
            accept="image/*"
            className="sr-only"
            disabled={disabled || loading}
            onChange={event => {
              const file = event.target.files?.[0]
              if (file) onChange(file)
              event.target.value = ''
            }}
          />
          <div className="flex flex-wrap gap-2">
            <label
              htmlFor={inputId}
              aria-disabled={disabled || loading}
              className={`btn-ghost inline-flex cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs ${
                disabled || loading ? 'pointer-events-none opacity-50' : ''
              }`}
            >
              <ImagePlus size={14} aria-hidden />
              <span>{photo ? t('collection.replaceOwnPhoto') : t('collection.uploadOwnPhoto')}</span>
            </label>
            {photo && !loading && (
              <button
                type="button"
                onClick={() => onChange(null)}
                disabled={disabled}
                className="btn-ghost inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-brand-red"
              >
                <Trash2 size={14} aria-hidden />
                <span>{t('collection.removeOwnPhoto')}</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
