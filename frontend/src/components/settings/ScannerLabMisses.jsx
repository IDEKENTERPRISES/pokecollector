import { useState } from 'react'
import { createPortal } from 'react-dom'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Loader2, X } from 'lucide-react'
import api from '../../api/client'
import { useDialogBehavior } from '../ui/dialogBehavior'

const PAGE = 24

/** One thumbnail with a caption; the pictures are small and loaded lazily (admin page, T340 traces). */
function Pic({ src, alt, caption, className = 'h-24', onOpen }) {
  const image = src ? <img src={src} alt={alt} loading="lazy" className={`${className} w-auto rounded-md bg-fill object-contain`} /> : null
  return (
    <figure className="m-0 min-w-0 flex-shrink-0">
      {image && onOpen ? (
        <button type="button" onClick={onOpen} aria-label={`Open ${alt} at full size`} className="ios-press block rounded-md" data-testid="miss-open">{image}</button>
      ) : image ? image : (
        <div className={`${className} flex aspect-[5/7] items-center justify-center rounded-md bg-fill text-footnote text-text-secondary`}>–</div>
      )}
      {caption && <figcaption className="mt-0.5 max-w-[7rem] truncate text-[11px] leading-tight text-text-secondary">{caption}</figcaption>}
    </figure>
  )
}

/** One picture at its real size: the box scrolls instead of shrinking the picture, and says how big it is. */
function RealSize({ title, src, hint, fit = false }) {
  const [size, setSize] = useState(null)
  return (
    <section className="space-y-1">
      <h4 className="text-subheadline font-semibold">{title}{size ? <span className="font-normal text-white/60"> · {size.w}×{size.h} px</span> : null}</h4>
      {hint && <p className="text-footnote text-white/60">{hint}</p>}
      {src ? (
        <div className="overflow-auto rounded-md bg-white/5" style={{ maxHeight: '85vh' }}>
          <img
            src={src}
            alt={title}
            onLoad={event => setSize({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
            className={fit ? 'h-auto w-full' : 'h-auto max-w-none'}
            data-testid="miss-full-image"
          />
        </div>
      ) : (
        <div className="grid h-24 place-items-center rounded-md bg-white/5 text-footnote text-white/60">not available</div>
      )}
    </section>
  )
}

/** Full-size pictures of one miss: the photo with the corners, the flat card as it was read (real size), the confirmed card. */
export function MissViewer({ item, onClose }) {
  const truth = item.truth || {}
  const { data, isLoading, isError } = useQuery({
    queryKey: ['card-match-miss-full', item.key],
    queryFn: () => api.get(`/card-match/misses/${encodeURIComponent(item.key)}/full`).then(response => response.data),
    staleTime: 300000,
    retry: false,
  })
  const { dialogRef, onDialogKeyDown } = useDialogBehavior(true, onClose)
  const read = item.text_input
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${truth.name || 'Miss'} at full size`}
      tabIndex={-1}
      data-testid="miss-viewer"
      onKeyDown={onDialogKeyDown}
      className="fixed inset-0 flex flex-col bg-black text-white"
      style={{ zIndex: 70 }}
    >
      <header className="flex items-center justify-between gap-3 px-4 pb-2 pt-[max(0.75rem,var(--safe-top))]">
        <p className="min-w-0 flex-1 truncate text-headline">{truth.name} <span className="font-normal text-white/60">#{truth.number}{truth.set ? ` · ${truth.set}` : ''}</span></p>
        <button type="button" onClick={onClose} aria-label="Close" data-testid="miss-viewer-close" className="ios-press grid h-11 w-11 flex-shrink-0 place-items-center rounded-full bg-white/15">
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-[max(1rem,var(--safe-bottom))]">
        {isLoading && <Loader2 size={24} className="mx-auto animate-spin" aria-label="Loading" />}
        {isError && <p className="text-footnote text-white/70">The full-size pictures are not available for this run.</p>}
        {!isLoading && (
          <>
            <RealSize title="Your photo, corners drawn" src={data?.photo} fit />
            <RealSize
              title="The flat card the matcher read"
              src={data?.card}
              hint={read ? `Text read from: ${read.source.replace('_', ' ')}, ${read.width}×${read.height} px. Scroll to see all of it.` : 'Scroll to see all of it.'}
            />
            <RealSize title="Confirmed card" src={truth.image_large || truth.image} fit />
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

function MissItem({ item, labels, onOpen }) {
  const truth = item.truth || {}
  return (
    <li className="space-y-1.5 py-2" data-testid="scanner-lab-miss">
      <div className="flex flex-wrap items-center gap-1.5 text-footnote">
        <span className="font-semibold">{truth.name || truth.tcg_card_id}</span>
        <span className="text-text-secondary">{truth.set ? `${truth.set} · ` : ''}#{truth.number}</span>
        <span className="text-text-secondary">· {item.kind === 'not_in_top20' ? 'not in the top 20' : `ranked ${item.rank}`}</span>
        {item.confirmation?.startsWith('manual_') && <span className="text-text-secondary" data-testid="miss-manual">· found by search</span>}
        {item.decided_wrong && <span className="font-semibold text-red-500">· decided wrong</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {item.tags.map(tag => (
          <span key={tag} className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] text-tint">{labels[tag] || tag}</span>
        ))}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        <Pic src={item.photo} alt="Photo with the detected corners" caption="photo + corners" onOpen={onOpen} />
        <Pic src={item.card} alt="Flat card the matcher used" caption="matcher’s crop" onOpen={onOpen} />
        <Pic src={truth.image} alt={`Confirmed: ${truth.name}`} caption="confirmed card" onOpen={onOpen} />
        {(item.top3 || []).map((match, position) => (
          <Pic
            key={match.tcg_card_id}
            src={match.image}
            alt={`Matcher pick ${position + 1}: ${match.name}`}
            caption={`${position + 1}. ${match.name} #${match.number} (${match.similarity})`}
          />
        ))}
      </div>
      <p className="break-words text-[11px] text-text-secondary" data-testid="scanner-lab-miss-ocr">
        Read: name “{item.ocr?.name || '–'}”, number {item.ocr?.number ? `${item.ocr.number}${item.ocr.total ? `/${item.ocr.total}` : ''}` : '–'}
        {item.ocr?.hp ? `, HP ${item.ocr.hp}` : ''}
        {(item.ocr?.lines || []).length > 0 ? ` · text: ${item.ocr.lines.join(' | ')}` : ''}
      </p>
      {item.rotation && (
        <p className="text-[11px] text-text-secondary" data-testid="scanner-lab-miss-rotation">
          Measured against the confirmed card: {item.rotation.rotated ? 'turned 180°' : 'upright'} (upright {item.rotation.upright}, turned {item.rotation.turned})
          {item.orientation?.by ? ` · matcher read it ${item.orientation.by === 'default' ? 'upright by default' : `${item.orientation.by === 'picture' ? 'as the picture said' : 'as the text said'}`}` : ''}
        </p>
      )}
    </li>
  )
}

/** The Misses view, presentational: counts per tag as filter chips, then the scans. */
export function MissesView({ data, tag, onTag, onMore }) {
  const [open, setOpen] = useState(null)
  const labels = data.tags || {}
  const counts = data.counts || {}
  const chip = 'rounded-full px-2.5 py-1 text-footnote ios-press'
  return (
    <div className="space-y-2 border-t border-separator px-4 py-3" data-testid="scanner-lab-misses">
      <div>
        <h3 className="text-subheadline font-semibold">Misses</h3>
        <p className="text-footnote text-text-secondary">
          {data.misses} of {data.scans} confirmed real scans where the right card was not the first pick
          {data.options ? ` (options: ${data.options})` : ''} · {data.created_at?.slice(0, 16).replace('T', ' ')} UTC. A scan can have several likely causes.
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5" data-testid="scanner-lab-miss-counts">
        <button type="button" className={`${chip} ${!tag ? 'bg-accent/30 font-semibold text-tint' : 'bg-fill'}`} onClick={() => onTag(null)}>All ({data.misses})</button>
        {Object.entries(labels).filter(([key]) => counts[key]).map(([key, label]) => (
          <button key={key} type="button" className={`${chip} ${tag === key ? 'bg-accent/30 font-semibold text-tint' : 'bg-fill'}`} onClick={() => onTag(key)}>
            {label} ({counts[key]})
          </button>
        ))}
      </div>
      <ul className="divide-y divide-separator">
        {data.items.map(item => <MissItem key={item.key} item={item} labels={labels} onOpen={() => setOpen(item)} />)}
      </ul>
      {data.offset + data.items.length < data.total && (
        <button type="button" className={`${chip} bg-accent/20 font-semibold text-tint`} onClick={onMore}>
          Show more ({data.total - data.offset - data.items.length} left)
        </button>
      )}
      {data.total === 0 && <p className="text-footnote text-text-secondary">Nothing in this group.</p>}
      {open && <MissViewer item={open} onClose={() => setOpen(null)} />}
    </div>
  )
}

/** Loads the misses of the last real-photo run, a page at a time. Admin only (the endpoint refuses others). */
export default function Misses() {
  const [tag, setTag] = useState(null)
  const [limit, setLimit] = useState(PAGE)
  const { data } = useQuery({
    queryKey: ['card-match-misses', tag, limit],
    queryFn: () => api.get('/card-match/misses', { params: { tag: tag || undefined, offset: 0, limit } }).then(response => response.data),
    placeholderData: keepPreviousData,
    staleTime: 60000,
    retry: false,
  })
  if (!data?.available) return null
  return <MissesView data={data} tag={tag} onTag={next => { setTag(next); setLimit(PAGE) }} onMore={() => setLimit(value => value + PAGE)} />
}
