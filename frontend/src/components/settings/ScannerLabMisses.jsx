import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import api from '../../api/client'

const PAGE = 24

/** One thumbnail with a caption; the pictures are small and loaded lazily (admin page, T340 traces). */
function Pic({ src, alt, caption, className = 'h-24' }) {
  return (
    <figure className="m-0 min-w-0 flex-shrink-0">
      {src ? (
        <img src={src} alt={alt} loading="lazy" className={`${className} w-auto rounded-md bg-fill object-contain`} />
      ) : (
        <div className={`${className} flex aspect-[5/7] items-center justify-center rounded-md bg-fill text-footnote text-text-secondary`}>–</div>
      )}
      {caption && <figcaption className="mt-0.5 max-w-[7rem] truncate text-[11px] leading-tight text-text-secondary">{caption}</figcaption>}
    </figure>
  )
}

function MissItem({ item, labels }) {
  const truth = item.truth || {}
  return (
    <li className="space-y-1.5 py-2" data-testid="scanner-lab-miss">
      <div className="flex flex-wrap items-center gap-1.5 text-footnote">
        <span className="font-semibold">{truth.name || truth.tcg_card_id}</span>
        <span className="text-text-secondary">{truth.set ? `${truth.set} · ` : ''}#{truth.number}</span>
        <span className="text-text-secondary">· {item.kind === 'not_in_top20' ? 'not in the top 20' : `ranked ${item.rank}`}</span>
        {item.decided_wrong && <span className="font-semibold text-red-500">· decided wrong</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {item.tags.map(tag => (
          <span key={tag} className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] text-tint">{labels[tag] || tag}</span>
        ))}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        <Pic src={item.photo} alt="Photo with the detected corners" caption="photo + corners" />
        <Pic src={item.card} alt="Flat card the matcher used" caption="matcher’s crop" />
        <Pic src={truth.image} alt={`Confirmed: ${truth.name}`} caption="confirmed card" />
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
    </li>
  )
}

/** The Misses view, presentational: counts per tag as filter chips, then the scans. */
export function MissesView({ data, tag, onTag, onMore }) {
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
        {data.items.map(item => <MissItem key={item.key} item={item} labels={labels} />)}
      </ul>
      {data.offset + data.items.length < data.total && (
        <button type="button" className={`${chip} bg-accent/20 font-semibold text-tint`} onClick={onMore}>
          Show more ({data.total - data.offset - data.items.length} left)
        </button>
      )}
      {data.total === 0 && <p className="text-footnote text-text-secondary">Nothing in this group.</p>}
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
