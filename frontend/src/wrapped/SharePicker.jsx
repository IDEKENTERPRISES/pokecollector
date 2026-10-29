import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { fill } from '../delights/delights'
import { sharePicture } from '../progress/shareImage'
import { PICTURE_KINDS, pictureAlt, pictureFileName, pictureOptions, renderPicture } from './shareWrapped'

// The share sheet of the Wrapped summary (P9c, §5): a preview of each picture the trainer can export
// (A, the trainer card poster, and B, the stat poster), each drawn once and shown scaled down. A tap
// shares that picture (or downloads it where files cannot be shared). The last choice is remembered.

export const SHARE_CHOICE_KEY = 'pc.wrapped.shareChoice'

const readChoice = () => {
  try {
    const value = globalThis.localStorage?.getItem(SHARE_CHOICE_KEY)
    return PICTURE_KINDS.includes(value) ? value : null
  } catch {
    return null
  }
}
const saveChoice = kind => {
  try {
    globalThis.localStorage?.setItem(SHARE_CHOICE_KEY, kind)
  } catch {
    // Storage blocked: the choice holds for this visit only.
  }
}

export default function SharePicker({ source, onClose }) {
  const { t, data } = source
  const [pictures, setPictures] = useState({})
  const [chosen, setChosen] = useState(readChoice)
  const options = useRef(null)
  if (!options.current) options.current = pictureOptions(source)

  useEffect(() => {
    let live = true
    const urls = []
    PICTURE_KINDS.forEach(kind => {
      renderPicture(kind, options.current).then(blob => {
        if (!live) return
        const url = blob ? URL.createObjectURL(blob) : null
        if (url) urls.push(url)
        setPictures(current => ({ ...current, [kind]: { blob, url, failed: !blob } }))
      }).catch(() => live && setPictures(current => ({ ...current, [kind]: { failed: true } })))
    })
    return () => {
      live = false
      urls.forEach(url => URL.revokeObjectURL(url))
    }
  }, [])

  useEffect(() => {
    const onKey = event => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const share = async kind => {
    const picture = pictures[kind]
    if (!picture?.blob) return
    setChosen(kind)
    saveChoice(kind)
    try {
      const result = await sharePicture(picture.blob, { name: pictureFileName(kind, data.year) })
      if (result === 'downloaded') toast.success(t('wrapped.shareDownloaded'))
      if (result !== 'cancelled') onClose()
    } catch {
      toast.error(t('wrapped.shareFailed'))
    }
  }

  const stop = event => event.stopPropagation()
  return (
    <div
      data-testid="wrapped-share-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={fill(t('wrapped.shareSheetTitle'), { year: data.year })}
      className="wp-sheet-backdrop"
      onPointerDown={stop}
      onPointerUp={stop}
      onClick={event => { if (event.target === event.currentTarget) onClose() }}
      style={{ position: 'absolute', inset: 0, zIndex: 10, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
    >
      <div className="wp-sheet" style={{
        width: '100%', maxWidth: 480, boxSizing: 'border-box', borderRadius: '28px 28px 0 0', background: '#1C1C1E', color: '#FFFFFF',
        padding: '10px 16px calc(env(safe-area-inset-bottom, 0px) + 16px)', lineHeight: 'normal', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
      }}>
        <div aria-hidden="true" style={{ width: 36, height: 5, borderRadius: 3, background: 'rgba(255,255,255,0.3)', margin: '0 auto 14px' }} />
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, textAlign: 'center' }}>{fill(t('wrapped.shareSheetTitle'), { year: data.year })}</h2>
        <p style={{ margin: '4px 0 16px', fontSize: 15, color: '#C7C7CC', textAlign: 'center' }}>{t('wrapped.shareSheetLine')}</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          {PICTURE_KINDS.map(kind => {
            const picture = pictures[kind]
            const selected = chosen === kind
            return (
              <button
                key={kind}
                type="button"
                data-testid={`wrapped-share-${kind}`}
                data-ready={picture?.blob ? 'true' : 'false'}
                onClick={() => share(kind)}
                disabled={!picture?.blob}
                aria-label={fill(t('wrapped.shareThis'), { name: t(`wrapped.picture.${kind}`) })}
                style={{
                  border: 0, padding: 0, background: 'transparent', color: 'inherit', fontFamily: 'inherit', textAlign: 'center',
                  display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 8, cursor: picture?.blob ? 'pointer' : 'default',
                }}
              >
                <span style={{
                  display: 'block', position: 'relative', aspectRatio: '9 / 16', borderRadius: 14, overflow: 'hidden', background: '#2C2C2E',
                  boxShadow: selected ? '0 0 0 3px #FFFFFF' : '0 0 0 1px rgba(255,255,255,0.12)',
                }}>
                  {picture?.url ? (
                    <img src={picture.url} alt={pictureAlt(kind, options.current)} data-testid={`wrapped-preview-${kind}`}
                      style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <span className="wp-shimmer" aria-label={picture?.failed ? t('wrapped.shareFailed') : t('wrapped.shareDrawing')}
                      style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 13, color: '#AEAEB2' }}>
                      {picture?.failed ? t('wrapped.shareFailed') : ''}
                    </span>
                  )}
                  {selected && picture?.url && (
                    <span style={{ position: 'absolute', left: 8, top: 8, padding: '3px 8px', borderRadius: 8, background: 'rgba(0,0,0,0.6)', fontSize: 12, fontWeight: 700 }}>
                      {t('wrapped.lastUsed')}
                    </span>
                  )}
                </span>
                <span style={{ fontSize: 15, fontWeight: 700 }}>{t(`wrapped.picture.${kind}`)}</span>
                <span style={{ fontSize: 13, color: '#AEAEB2', marginTop: -4 }}>{t(`wrapped.pictureLine.${kind}`)}</span>
              </button>
            )
          })}
        </div>
        <button type="button" onClick={onClose} data-testid="wrapped-share-cancel" style={{
          marginTop: 16, width: '100%', minHeight: 48, border: 0, borderRadius: 24, background: 'rgba(255,255,255,0.14)', color: '#FFFFFF',
          fontFamily: 'inherit', fontSize: 16, fontWeight: 700,
        }}>{t('wrapped.cancel')}</button>
      </div>
    </div>
  )
}
