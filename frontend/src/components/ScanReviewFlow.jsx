import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, Check, ChevronLeft, Loader2, Plus, Search, SkipForward, Trash2, X } from 'lucide-react'
import toast from 'react-hot-toast'
import {
  fetchScanJobItemImageBlob,
  resolveAndAddScanJobItem,
  resolveScanJobItem,
  searchCards,
  waitForScannerJobItem,
} from '../api/client'
import AuthContext from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { attachCollectionPhoto } from '../utils/collectionPhoto'
import { CARD_VARIANTS, getDefaultVariant } from '../utils/cardVariants'
import { resolveCardImageUrl } from '../utils/imageUrl'
import { invalidateCardState, invalidateTcgdexFilterLanguages } from '../utils/queryInvalidation'
import { SCAN_QUEUE_QUERY_KEY, SCAN_JOBS_QUERY_KEY, orderForReview } from '../utils/scanJobs'
import { useScanItemPhoto } from './ScanReview'
import TcgdexLanguageSelect from './TcgdexLanguageSelect'
import Alert from './ios/Alert'
import Button from './ios/Button'

const stripLangSuffix = id => String(id || '').replace(/_[a-z]{2,3}(-[a-z]+)?$/i, '')

// One card, whether it came from the scan's candidates or from the search box.
function toView(card) {
  if (!card) return null
  return {
    id: card.id,
    tcgId: card.tcg_card_id || stripLangSuffix(card.id),
    name: card.name,
    setName: card.set_ref?.name || card.set_name || card.set || '',
    number: card.number || '',
    image: card.image || resolveCardImageUrl(card),
    lang: card.lang || null,
    raw: card,
  }
}

function setAndNumber(view) {
  return [view.setName, view.number && `#${view.number}`].filter(Boolean).join(' · ')
}

// The app's card search (GET /cards/search), as a one-pick list.
function CardSearchPicker({ onPick, onBack, backLabel, t, autoFocus = true }) {
  const [text, setText] = useState('')
  const debounced = useDebouncedValue(text.trim(), 300)
  const { data, isFetching } = useQuery({
    queryKey: ['scan-flow-search', debounced],
    queryFn: () => searchCards({ name: debounced, lang: 'all', page: 1, page_size: 30 }).then(response => response.data),
    enabled: debounced.length >= 2,
  })
  const cards = data?.data || []
  return (
    <div className="space-y-3" data-testid="scan-flow-search">
      {onBack && (
        <button type="button" onClick={onBack} className="ios-press flex min-h-[44px] items-center gap-1 text-body text-tint">
          <ChevronLeft size={18} aria-hidden="true" /> {backLabel}
        </button>
      )}
      <label className="flex h-11 items-center gap-2 rounded-[12px] bg-fill-tertiary px-3">
        <Search size={16} aria-hidden="true" className="text-text-secondary" />
        <input
          type="search"
          value={text}
          onChange={event => setText(event.target.value)}
          placeholder={t('scanner.flowSearchPlaceholder')}
          aria-label={t('scanner.flowSearchPlaceholder')}
          enterKeyHint="search"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          className="min-w-0 flex-1 bg-transparent text-[16px] text-text-primary outline-none placeholder:text-text-tertiary"
        />
      </label>
      {debounced.length < 2 && <p className="text-footnote text-text-secondary">{t('scanner.flowSearchHint')}</p>}
      {isFetching && <Loader2 size={18} className="animate-spin text-tint" aria-label={t('common.loading')} />}
      {debounced.length >= 2 && !isFetching && cards.length === 0 && (
        <p className="text-footnote text-text-secondary">{t('scanner.flowSearchNone')}</p>
      )}
      <ul className="space-y-1.5">
        {cards.map(card => {
          const view = toView(card)
          return (
            <li key={card.id}>
              <button
                type="button"
                onClick={() => onPick(view)}
                data-testid="scan-flow-search-result"
                className="ios-press flex min-h-[56px] w-full items-center gap-3 rounded-xl bg-card p-2 text-left"
              >
                {view.image
                  ? <img src={view.image} alt="" loading="lazy" className="h-12 w-[34px] flex-shrink-0 rounded object-cover" />
                  : <span className="h-12 w-[34px] flex-shrink-0 rounded bg-fill-tertiary" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-semibold text-text-primary">{view.name}</span>
                  <span className="block truncate text-footnote text-text-secondary">{setAndNumber(view)}{view.lang ? ` · ${view.lang.toUpperCase()}` : ''}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// Where this item is in its life: something to decide on, still being recognised, or waiting for the scanner.
export const itemKind = item => {
  if (item.status === 'done') return (item.matches || []).length ? 'matches' : 'none'
  if (item.status === 'failed') return 'none'
  if (item.status === 'retrying' && item.retry_reason === 'scanner_unreachable') return 'waiting'
  return 'processing'
}

function ItemCard({ item, onAdded, onDismiss, onSkip, onWaited, t, overlayEl }) {
  const photoUrl = useScanItemPhoto(item.job_id, item)
  const kind = itemKind(item)
  const matches = useMemo(() => item.matches || [], [item.matches])
  const [index, setIndex] = useState(0)
  const [searching, setSearching] = useState(kind === 'none' || kind === 'waiting')
  const [picked, setPicked] = useState(null) // a card found by search
  const [quantity, setQuantity] = useState(1)
  const [condition, setCondition] = useState('NM')
  const [variantOverride, setVariantOverride] = useState(null)
  const [lang, setLang] = useState(null)
  const [adding, setAdding] = useState(false)
  const [confirmDismiss, setConfirmDismiss] = useState(false)
  const queryClient = useQueryClient()
  const isAdmin = useContext(AuthContext)?.user?.role === 'admin'
  // "Picture match first" (docs/CARD_MATCH.md): the picture decided the card, or was unsure while the scanner
  // was unreachable and sent the scan here with its best matches.
  const picture = item.recognized?._picture
  const pictureUnsure = item.status === 'done' && !item.resolved && picture?.path === 'unsure_inbox'
  const matchedByPicture = isAdmin && picture?.path === 'decided'
  const [waiting, setWaiting] = useState(false)

  const chosen = picked || toView(matches[index])
  const variant = variantOverride || (chosen ? getDefaultVariant(chosen.raw) : 'Normal')
  const effectiveLang = lang || item.recognized?.language || chosen?.lang || 'en'

  const choose = view => {
    setPicked(view)
    setSearching(false)
    setVariantOverride(null)
    setLang(view.lang)
  }

  const add = async () => {
    if (!chosen || adding) return
    setAdding(true)
    try {
      // The photo goes with the card as "my card photo"; resolving the scan deletes it, so fetch it first.
      const photo = item.has_image ? await fetchScanJobItemImageBlob(item.job_id, item.id).catch(() => null) : null
      const result = await resolveAndAddScanJobItem(item.job_id, item.id, {
        card_id: chosen.id,
        quantity,
        condition,
        variant,
        printing_details: [],
        lang: effectiveLang,
        purchase_price: null,
        confirmed_card_id: chosen.tcgId,
        manual_search: Boolean(picked),
      })
      await attachCollectionPhoto({ created: result.collection_item, photo })
      invalidateCardState(queryClient)
      invalidateTcgdexFilterLanguages(queryClient)
      onAdded(item)
    } catch (error) {
      toast.error(error?.response?.data?.detail || t('card.addFailed'))
    } finally {
      setAdding(false)
    }
  }

  const scannerDown = kind === 'waiting'
  const noResult = kind === 'none'
  const heading = useRef(null)
  useEffect(() => { heading.current?.focus() }, [item.id])

  return (
    <div className="space-y-4" data-testid="scan-flow-card" data-item-id={item.id}>
      <div className="flex items-start gap-3">
        <div className="w-24 flex-shrink-0">
          <div className="grid aspect-[2.5/3.5] w-full place-items-center overflow-hidden rounded-xl bg-black ring-1 ring-white/10">
            {photoUrl
              ? <img src={photoUrl} alt={t('scanner.yourPhoto')} className="h-full w-full object-contain" />
              : <Camera size={28} aria-hidden="true" className="text-text-tertiary" />}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <h2 ref={heading} tabIndex={-1} className="text-headline text-text-primary outline-none">
            {chosen && !searching ? chosen.name : t('scanner.photoNumber') + ' ' + (item.position + 1)}
          </h2>
          {chosen && !searching && <p className="text-subheadline text-text-secondary" data-testid="scan-flow-chosen">{setAndNumber(chosen)}</p>}
          {!searching && picked && <p className="mt-1 text-footnote text-text-secondary">{t('scanner.flowFoundBySearch')}</p>}
          {matchedByPicture && <p className="mt-1 text-caption-1 text-text-tertiary" data-testid="scan-matched-by-picture">{t('scanner.matchedByPicture')}</p>}
        </div>
      </div>

      {pictureUnsure && (
        <p role="status" data-testid="scan-picture-unsure" className="rounded-xl bg-fill-tertiary px-3 py-2 text-subheadline text-text-secondary">
          {t('scanner.pictureUnsure')}
        </p>
      )}
      {scannerDown && (
        <p role="status" className="rounded-xl bg-fill-tertiary px-3 py-2 text-subheadline text-text-secondary">
          {t('scanner.flowWaitingHint')}
        </p>
      )}
      {noResult && (
        <p role="status" className="rounded-xl bg-fill-tertiary px-3 py-2 text-subheadline text-text-secondary">
          {item.error || t('scanner.flowNoResult')}
        </p>
      )}

      {searching ? (
        <CardSearchPicker
          onPick={choose}
          onBack={matches.length && !picked ? () => setSearching(false) : picked ? () => setSearching(false) : null}
          backLabel={t('scanner.flowBackToMatches')}
          t={t}
          autoFocus={!matches.length}
        />
      ) : chosen && (
        <>
          <div className="flex items-center gap-4 rounded-[20px] bg-card p-4">
            {chosen.image && (
              <img src={chosen.image} alt={chosen.name} data-testid="scan-flow-best-image" className="w-[38%] max-w-[190px] flex-shrink-0 rounded-xl" />
            )}
            <div className="grid min-w-0 flex-1 gap-3">
              <label className="block">
                <span className="mb-1 block text-footnote text-text-secondary">{t('common.quantity')}</span>
                <input
                  type="number" inputMode="numeric" min="1" value={quantity}
                  onChange={event => setQuantity(Math.max(1, parseInt(event.target.value, 10) || 1))}
                  className="input min-h-[44px]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-footnote text-text-secondary">{t('card.condition')}</span>
                <select value={condition} onChange={event => setCondition(event.target.value)} className="select min-h-[44px]">
                  {['Mint', 'NM', 'LP', 'MP', 'HP'].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-footnote text-text-secondary">{t('card.variant')}</span>
                <select value={variant} onChange={event => setVariantOverride(event.target.value)} className="select min-h-[44px]">
                  {CARD_VARIANTS.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-footnote text-text-secondary">{t('lang.filter')}</span>
                <TcgdexLanguageSelect value={effectiveLang} onChange={setLang} className="select min-h-[44px] w-full" />
              </label>
            </div>
          </div>

          {!picked && matches.length > 1 && (
            <div>
              <p className="mb-2 text-footnote font-semibold uppercase tracking-wide text-text-secondary">{t('scanner.flowOtherMatches')}</p>
              <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" data-testid="scan-flow-candidates">
                {matches.map((match, position) => {
                  const view = toView(match)
                  return (
                    <li key={`${match.tcg_card_id}-${position}`} className="w-24 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => { setIndex(position); setVariantOverride(null) }}
                        aria-pressed={position === index}
                        aria-label={`${view.name} ${setAndNumber(view)}`}
                        className={`ios-press block w-full rounded-xl p-1 text-left ${position === index ? 'bg-accent/25 ring-2 ring-tint' : 'bg-card'}`}
                      >
                        {view.image && <img src={view.image} alt="" loading="lazy" className="w-full rounded-lg" />}
                        <span className="mt-1 block truncate text-caption-1 font-semibold text-text-primary">{view.name}</span>
                        <span className="block truncate text-caption-1 text-text-secondary">{view.number && `#${view.number}`}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </>
      )}

      <div className="sticky bottom-0 -mx-4 space-y-2 bg-bg px-4 pb-1 pt-3">
        {chosen && !searching && (
          <Button full size="lg" icon={adding ? undefined : Plus} loading={adding} onClick={add} data-testid="scan-flow-add">
            {adding ? t('scanner.adding') : t('scanner.addToCollection')}
          </Button>
        )}
        <div className="grid grid-cols-2 gap-2">
          {!searching && !picked && matches.length > 1 && (
            <Button variant="gray" onClick={() => { setIndex(current => (current + 1) % matches.length); setVariantOverride(null) }} data-testid="scan-flow-pick-another">
              {t('scanner.flowPickAnother')}
            </Button>
          )}
          {!searching && (
            <Button variant="gray" icon={Search} onClick={() => setSearching(true)} data-testid={matches.length ? 'scan-flow-none' : 'scan-flow-search-open'}>
              {matches.length && !picked ? t('scanner.flowNoneOfThese') : t('scanner.flowSearch')}
            </Button>
          )}
          {pictureUnsure && item.has_image && (
            <Button
              variant="gray"
              loading={waiting}
              onClick={async () => {
                setWaiting(true)
                try {
                  await waitForScannerJobItem(item.job_id, item.id)
                  onWaited(item)
                } catch (error) {
                  toast.error(error?.response?.data?.detail || t('scanner.actionFailed'))
                } finally {
                  setWaiting(false)
                }
              }}
              data-testid="scan-flow-wait"
            >
              {t('scanner.waitForScanner')}
            </Button>
          )}
          <Button variant="gray" icon={SkipForward} onClick={() => onSkip(item)} data-testid="scan-flow-skip">
            {scannerDown ? t('scanner.flowWaitForScanner') : t('scanner.flowSkip')}
          </Button>
          <Button variant="gray" destructive icon={Trash2} onClick={() => setConfirmDismiss(true)} data-testid="scan-flow-dismiss">
            {t('scanner.dismissScan')}
          </Button>
        </div>
      </div>

      {overlayEl && (
        <Alert
          isOpen={confirmDismiss}
          onClose={() => setConfirmDismiss(false)}
          title={t('scanner.dismissScan')}
          message={t('scanner.dismissScanConfirm')}
          container={overlayEl}
          opaque
          actions={[
            { label: t('common.cancel'), style: 'cancel', onSelect: () => setConfirmDismiss(false) },
            {
              label: t('scanner.dismissScan'),
              style: 'destructive',
              preferred: true,
              onSelect: () => { setConfirmDismiss(false); onDismiss(item) },
            },
          ]}
        />
      )}
    </div>
  )
}

/**
 * Review every scan waiting for a decision, one card after another: confirm the best match (or pick
 * another, or search for the card), add it, and the next card is there. `items` is the flat queue from
 * GET /cards/recognize/queue. Leaving loses nothing: a scan is only ever finished by adding or dismissing
 * it, so reopening starts again at the first one still waiting (skipped scans come back at the end).
 */
export default function ScanReviewFlow({ items, startItemId = null, onClose }) {
  const { t } = useSettings()
  const queryClient = useQueryClient()
  const [overlayEl, setOverlayEl] = useState(null)
  const [skipped, setSkipped] = useState([])
  const [added, setAdded] = useState(0)
  const [dismissed, setDismissed] = useState(0)
  const [gone, setGone] = useState([]) // finished this session, before the list refetches
  const [startId, setStartId] = useState(startItemId)

  const ordered = useMemo(
    () => orderForReview(items.filter(item => !gone.includes(item.id)), { skipped, startId }, itemKind),
    [items, gone, skipped, startId],
  )
  const current = ordered.current
  const handled = added + dismissed
  const total = handled + ordered.ready.length + ordered.processing.length + ordered.skipped.length

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: SCAN_QUEUE_QUERY_KEY })
    queryClient.invalidateQueries({ queryKey: SCAN_JOBS_QUERY_KEY })
  }
  const finish = (item, kind) => {
    setGone(list => [...list, item.id])
    setStartId(null)
    if (kind === 'added') setAdded(count => count + 1)
    else setDismissed(count => count + 1)
    refresh()
  }
  const dismiss = async item => {
    try {
      await resolveScanJobItem(item.job_id, item.id, null)
      finish(item, 'dismissed')
    } catch (error) {
      toast.error(error?.response?.data?.detail || t('scanner.actionFailed'))
    }
  }
  // "Wait for the scanner": the scan goes back to waiting, so it leaves this pass like a skipped one.
  const waited = item => {
    skip(item)
    refresh()
  }
  const skip = item => {
    setStartId(null)
    setSkipped(list => (list.includes(item.id) ? list : [...list, item.id]))
  }

  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [])

  const progress = current
    ? t('scanner.flowProgress').replace('{n}', String(handled + 1)).replace('{total}', String(total))
    : ''
  const stillRecognising = ordered.processing.length
  let body
  if (current) {
    body = <ItemCard key={current.id} item={current} onAdded={item => finish(item, 'added')} onDismiss={dismiss} onSkip={skip} onWaited={waited} t={t} overlayEl={overlayEl} />
  } else if (stillRecognising) {
    body = (
      <div role="status" className="space-y-4 py-10 text-center" data-testid="scan-flow-recognising">
        <Loader2 size={28} className="mx-auto animate-spin text-tint" aria-hidden="true" />
        <p className="text-body text-text-primary">{t('scanner.flowRecognising').replace('{n}', String(stillRecognising))}</p>
        {ordered.skipped.length > 0 && (
          <Button variant="gray" onClick={() => setSkipped([])}>{t('scanner.flowReviewSkipped').replace('{n}', String(ordered.skipped.length))}</Button>
        )}
      </div>
    )
  } else {
    body = (
      <div className="space-y-4 py-10 text-center" data-testid="scan-flow-done">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-green/20"><Check size={28} className="text-green" aria-hidden="true" /></span>
        <h2 className="text-title-3 font-semibold text-text-primary">{t('scanner.flowDoneTitle')}</h2>
        <p className="text-subheadline text-text-secondary">
          {t('scanner.flowDoneBody').replace('{added}', String(added)).replace('{dismissed}', String(dismissed))}
        </p>
        {ordered.skipped.length > 0 && (
          <Button variant="tinted" onClick={() => setSkipped([])} data-testid="scan-flow-review-skipped">
            {t('scanner.flowReviewSkipped').replace('{n}', String(ordered.skipped.length))}
          </Button>
        )}
        <Button full onClick={onClose} data-testid="scan-flow-finish">{t('scanner.flowDone')}</Button>
      </div>
    )
  }

  return createPortal(
    <div
      ref={setOverlayEl}
      role="dialog"
      aria-modal="true"
      aria-label={t('scanner.flowTitle')}
      data-testid="scan-review-flow"
      className="fixed inset-0 flex flex-col bg-bg text-text-primary"
      style={{ zIndex: 'var(--z-scanner)' }}
      onKeyDown={event => { if (event.key === 'Escape') onClose() }}
    >
      <header className="flex items-center justify-between gap-3 px-4 pb-2 pt-[max(0.75rem,var(--safe-top))]">
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="ios-press grid h-11 w-11 place-items-center rounded-full bg-fill-tertiary">
          <X size={20} aria-hidden="true" />
        </button>
        <p className="text-headline tabular-nums" aria-live="polite" data-testid="scan-flow-progress">{progress || t('scanner.flowTitle')}</p>
        <span className="h-11 w-11" aria-hidden="true" />
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,var(--safe-bottom))] pt-2">
        {body}
      </main>
    </div>,
    document.body,
  )
}
