import { useState } from 'react'
import { ArrowLeftRight, Check, ChevronRight, Heart, Wallet } from 'lucide-react'
import clsx from 'clsx'
import Link from '../components/ios/TransitionLink'
import Button from '../components/ios/Button'
import { HIDDEN_VALUE, useHideValues } from '../components/ios/hideValues'
import { TYPE_COLOURS, typeKeyFor } from '../components/ios/pokemon'
import { useSettings } from '../contexts/SettingsContext'
import { cardImageUrl } from '../utils/imageUrl'
import { TrainerAvatar } from '../pages/socialParts'
import {
  VERDICT_COLOURS,
  offerSummary,
  parseServerTime,
  shortAgeLabel,
  dayMonth,
  swapStatus,
  tradeVerdict,
  sideItems,
  addedKeys,
  isOpen,
  joinNames,
} from './swapHelpers'

const fill = (text, values) => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, value), text)

const TONE_CHIP = {
  yellow: 'bg-yellow/20 text-yellow',
  green: 'bg-green/20 text-green',
  gray: 'bg-fill-tertiary text-text-secondary',
  red: 'bg-red/15 text-red',
}
const TONE_TEXT = {
  yellow: 'text-yellow',
  green: 'text-green',
  gray: 'text-text-secondary',
  red: 'text-red',
}
const TONE_DOT = { yellow: 'bg-yellow', green: 'bg-green', gray: 'bg-text-secondary', red: 'bg-red' }

/** The signed amount for the meter: "+£0.30", "-£1.20", or •••• while values are hidden. */
export function useSignedMoney() {
  const { formatPrice } = useSettings()
  const { hidden } = useHideValues()
  return (amount) => {
    if (hidden) return HIDDEN_VALUE
    const value = Number(amount) || 0
    return `${value < 0 ? '-' : '+'}${formatPrice(Math.abs(value))}`
  }
}

function typeSolid(types) {
  const key = typeKeyFor(Array.isArray(types) ? types[0] : types) ?? 'colorless'
  return { key, ...TYPE_COLOURS[key] }
}

/**
 * A card picture at its own size: the catalogue image, or, when it fails to load, the drawn card in the
 * card's type colours (frame, picture window, two text lines), as the mockups draw it.
 */
export function CardArt({ item, width = 40, height = 56, radius = 5, glow = true, className = '', style }) {
  const [failed, setFailed] = useState(false)
  const { key, top, bottom, solid } = typeSolid(item?.types)
  const src = item?.card_id && !failed ? cardImageUrl(item.card_id, 'small') : null
  const window = `linear-gradient(160deg, color-mix(in srgb, ${solid} 45%, white), ${solid})`
  return (
    <span
      aria-hidden="true"
      data-card-art={key}
      className={clsx('relative block flex-shrink-0 overflow-hidden', className)}
      style={{
        width,
        height,
        borderRadius: radius,
        background: `linear-gradient(150deg, ${top}, ${bottom})`,
        boxShadow: glow ? `0 2px 8px color-mix(in srgb, ${solid} 35%, transparent)` : undefined,
        ...style,
      }}
    >
      {src ? (
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} className="h-full w-full object-cover" />
      ) : (
        <>
          <span className="absolute left-[3px] right-[3px] top-1 h-[45%] rounded-sm" style={{ background: window }} />
          <span className="absolute left-1 right-1 h-[3px] rounded-sm bg-white/55" style={{ top: '60%' }} />
          <span className="absolute left-1 right-3 h-[3px] rounded-sm bg-white/35" style={{ top: '71%' }} />
        </>
      )}
    </span>
  )
}

/** "Your turn", "Waiting for Misty", ... as a capsule (page background) or a dot and text (inside rows). */
export function SwapStatusChip({ offer, variant = 'capsule', suffix = '' }) {
  const { t } = useSettings()
  const { tone, key, partner } = swapStatus(offer)
  const label = fill(t(key), { name: partner }) + suffix
  if (variant === 'dot') {
    return (
      <span className={clsx('mt-[3px] flex items-center gap-1.5 text-caption-1 font-semibold', TONE_TEXT[tone])}>
        <span aria-hidden="true" className={clsx('h-2 w-2 flex-shrink-0 rounded-full', TONE_DOT[tone])} />
        {label}
      </span>
    )
  }
  return (
    <span className={clsx('inline-flex min-h-[24px] items-center rounded-full px-2.5 text-footnote font-semibold', TONE_CHIP[tone])}>
      {label}
    </span>
  )
}

/** One row of the Offers segment (docs/SOCIAL_DESIGN.md §5.3): a link to the offer. */
export function SwapOfferRow({ offer }) {
  const { t } = useSettings()
  const partner = offer.partner?.username ?? ''
  const gets = sideItems(offer, false)
  const gives = sideItems(offer, true)
  const finished = !isOpen(offer) && offer.state !== 'accepted'
  const age = finished
    ? dayMonth(offer.state === 'completed' ? offer.completed_at : offer.updated_at)
    : shortAgeLabel(offer.updated_at)
  const status = swapStatus(offer)
  const names = list => joinNames(list.map(item => item.card_name))
  const left = offer.expires_at && isOpen(offer) && !offer.your_turn
    ? Math.max(0, Math.ceil(((parseServerTime(offer.expires_at) ?? 0) - Date.now()) / 86400000))
    : null
  const suffix = left != null ? ` · ${fill(t(left === 1 ? 'swaps.daysLeftOne' : 'swaps.daysLeft'), { count: left })}` : ''
  const label = [
    fill(t('swaps.rowWith'), { name: partner }),
    gets.length ? fill(t('swaps.rowYouGet'), { cards: names(gets) }) : null,
    gives.length ? fill(t('swaps.rowYouGive'), { cards: names(gives) + (Number(offer.cash?.amount) > 0 ? ` ${t('swaps.andCash')}` : '') }) : null,
    fill(t(status.key), { name: partner }) + suffix,
    finished ? fill(t('swaps.rowOn'), { date: age }) : fill(t('swaps.rowAgo'), { age }),
    (offer.unavailable?.length ?? 0) > 0 ? t('swaps.cardMissing') : null,
  ].filter(Boolean).join('. ') + '.'
  return (
    <Link
      to={`/trades/offers/${offer.id}`}
      aria-label={label}
      data-testid="swap-offer-row"
      className="relative flex min-h-[76px] w-full items-center gap-3 py-3 pl-4 pr-2.5 text-left after:pointer-events-none after:absolute after:bottom-0 after:left-[68px] after:right-0 after:h-[0.5px] after:bg-border last:after:hidden active:bg-elevated"
    >
      <TrainerAvatar avatarId={offer.partner?.avatar_id} size={40} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline justify-between gap-2">
          <span className="text-headline text-text-primary">{partner}</span>
          <span className="text-footnote tabular-nums text-text-secondary">{age}</span>
        </span>
        <span className="truncate text-footnote text-text-secondary">{offerSummary(offer, t)}</span>
        <SwapStatusChip offer={offer} variant="dot" suffix={suffix} />
        {(offer.unavailable?.length ?? 0) > 0 && (
          <span data-testid="swap-card-missing" className="mt-[3px] text-caption-1 font-semibold text-red">{t('swaps.cardMissing')}</span>
        )}
      </span>
      <span aria-hidden="true" className="relative h-[50px] w-[42px] flex-shrink-0">
        <CardArt item={gets[0] ?? gives[0]} width={28} height={39} radius={3} glow={false} className="!absolute left-0 top-0" />
        <CardArt item={gives[0] ?? gets[0]} width={28} height={39} radius={3} glow={false} className="!absolute left-3.5 top-[11px]" style={{ boxShadow: '0 0 0 1.5px var(--color-card)' }} />
      </span>
      <ChevronRight size={18} strokeWidth={2.25} className="flex-shrink-0 text-text-tertiary" aria-hidden="true" />
    </Link>
  )
}

/**
 * The fair-trade meter (docs/SOCIAL_DESIGN.md §5.6): verdict, signed delta, a balance track with four
 * zones and a marker, and the two totals. 'full' sits in a card; 'compact' is the composer's footer.
 * Hide-values masks every amount; the verdict, zones and marker stay.
 */
export function FairTradeMeter({ gives = 0, gets = 0, missingPrices = 0, scoreGives, variant = 'full', className = '' }) {
  const { t, formatPrice } = useSettings()
  const { hidden } = useHideValues()
  const signed = useSignedMoney()
  const verdict = tradeVerdict({ gives, gets, missingPrices, scoreGives })
  const colour = VERDICT_COLOURS[verdict.key]
  const title = t(`swaps.meter.${verdict.key}`)
  const giveText = fill(t('swaps.meter.youGive'), { amount: formatPrice(gives) })
  const getText = fill(t('swaps.meter.youGet'), { amount: formatPrice(gets) })
  const showDelta = verdict.key !== 'empty' && verdict.key !== 'missing'
  const label = hidden
    ? fill(t('swaps.meter.labelHidden'), { verdict: title })
    : fill(t('swaps.meter.label'), { verdict: title, give: formatPrice(gives), get: formatPrice(gets) })
  const compact = variant === 'compact'
  const deltaColour = verdict.delta >= 0 ? 'text-green' : 'text-red'
  return (
    <div
      role="img"
      aria-label={label}
      data-testid="fair-trade-meter"
      data-verdict={verdict.key}
      className={clsx(!compact && 'rounded-xl bg-card p-4', className)}
    >
      {compact ? (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-headline text-text-primary">{title}</span>
          {showDelta && <span className={clsx('text-headline tabular-nums', deltaColour)}>{signed(verdict.delta)}</span>}
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="grid h-[29px] w-[29px] flex-shrink-0 place-items-center rounded-[7px] text-white" style={{ background: colour }}>
            <ArrowLeftRight size={18} strokeWidth={1.9} />
          </span>
          <span className="flex-1">
            <span className="block text-headline text-text-primary">{title}</span>
            {verdict.key === 'missing' && <span className="block text-footnote text-text-secondary">{t('swaps.meter.missingDetail')}</span>}
          </span>
          {showDelta && <span className={clsx('text-headline tabular-nums', deltaColour)}>{signed(verdict.delta)}</span>}
        </div>
      )}
      <div
        aria-hidden="true"
        className={clsx('relative h-2 rounded-full bg-black/45 shadow-[inset_0_0_0_0.5px_rgba(255,255,255,0.12)]', compact ? 'mt-2' : 'mt-3')}
      >
        <span className="absolute inset-y-0 left-0 w-1/4 rounded-l-full" style={{ background: 'rgba(255,69,58,0.35)' }} />
        <span className="absolute inset-y-0 left-1/4 w-[16.67%]" style={{ background: 'rgba(255,214,10,0.35)' }} />
        <span className="absolute inset-y-0 left-[41.67%] w-[33.33%]" style={{ background: 'rgba(48,209,88,0.35)' }} />
        <span className="absolute inset-y-0 left-3/4 w-1/4 rounded-r-full" style={{ background: 'rgba(10,132,255,0.35)' }} />
        {verdict.position != null && (
          <span
            className="absolute top-1/2 -mt-2 box-border h-4 w-4 rounded-full border-[3px] bg-white shadow-[0_1px_4px_rgba(0,0,0,0.5)]"
            style={{ left: `clamp(0px, calc(${(verdict.position * 100).toFixed(1)}% - 8px), calc(100% - 16px))`, borderColor: colour }}
          />
        )}
      </div>
      {verdict.key !== 'empty' && verdict.key !== 'missing' && (
        <div className={clsx('flex justify-between gap-2 text-footnote tabular-nums text-text-secondary', compact ? 'mt-2' : 'mt-1.5')}>
          <span>{giveText}</span>
          <span>{getText}</span>
        </div>
      )}
    </div>
  )
}

function CashLine({ amount, who }) {
  const { t, formatPrice } = useSettings()
  const text = formatPrice(amount)
  return (
    <div className="flex min-h-[36px] items-center gap-2.5" aria-label={fill(t(who === 'me' ? 'swaps.cashYouPay' : 'swaps.cashTheyPay'), { amount: text })}>
      <span aria-hidden="true" className="mx-[5.5px] grid h-[29px] w-[29px] flex-shrink-0 place-items-center rounded-[7px] bg-orange text-white">
        <Wallet size={18} strokeWidth={1.9} />
      </span>
      <span className="min-w-0">
        <span className="block text-subheadline font-semibold">{t('swaps.cash')}</span>
        <span className="block text-footnote tabular-nums text-text-secondary">{text}</span>
      </span>
    </div>
  )
}

function SideCard({ item, past, added, unavailable, onOpenCard }) {
  const { t, formatPrice } = useSettings()
  const conditionNote = !past && item.now_condition ? fill(t('swaps.conditionNow'), { now: item.now_condition, was: item.condition || 'NM' }) : null
  const detail = [item.set_code || item.set_id?.toUpperCase(), item.card_number].filter(Boolean).join(' ') + (item.variant ? ` · ${item.variant}` : '')
  const value = formatPrice(Number(item.value_per_card) * Number(item.quantity || 1))
  const quantity = Number(item.quantity) > 1 ? `×${item.quantity} ` : ''
  const name = `${quantity}${item.card_name}`
  const aria = unavailable
    ? fill(t('swaps.cardGoneLabel'), { name: item.card_name, detail })
    : `${name}, ${detail}, ${value}${added ? `, ${t('swaps.addedBy').replace('{name}', added)}` : ''}${onOpenCard && !unavailable ? `. ${t('swaps.openCard')}` : ''}`
  const body = (
    <>
      <CardArt item={item} glow={!unavailable} style={unavailable ? { opacity: 0.45 } : undefined} />
      <span className="min-w-0">
        <span className="block text-subheadline font-semibold">{name}</span>
        <span className="block text-caption-1 text-text-secondary">{detail}</span>
        {unavailable ? (
          <span className="block text-caption-1 font-semibold text-red">{unavailable}</span>
        ) : added ? (
          <span className="flex items-center gap-1.5">
            <span className="text-footnote tabular-nums text-text-secondary">{value}</span>
            <span className="inline-flex h-[18px] items-center rounded-full bg-accent/20 px-1.5 text-caption-2 font-semibold text-tint">{t('swaps.added')}</span>
          </span>
        ) : (
          <span className="block text-footnote tabular-nums text-text-secondary">{value}</span>
        )}
        {conditionNote && !unavailable && (
          <span data-testid="swap-condition-note" className="block text-caption-1 text-text-secondary">{conditionNote}</span>
        )}
      </span>
    </>
  )
  const classes = 'flex min-h-[56px] w-full min-w-0 items-center gap-2.5 text-left'
  if (onOpenCard && !unavailable) {
    return <button type="button" onClick={() => onOpenCard(item)} aria-label={aria} className={classes}>{body}</button>
  }
  return <div aria-label={aria} role="group" className={classes}>{body}</div>
}

/**
 * The two columns of an offer (docs/SOCIAL_DESIGN.md §5.5). `past` renders the cards read only with
 * "You got / You gave" titles; `unavailable` is the server's list of cards that are gone.
 */
export function SwapSides({ offer, viewerId, past = false, unavailable = [], onOpenCard }) {
  const { t } = useSettings()
  const partner = offer.partner?.username ?? ''
  const gets = sideItems(offer, false)
  const gives = sideItems(offer, true)
  const added = addedKeys(offer)
  const gone = new Map(unavailable.map(problem => [problem.item_id, problem]))
  const cash = Number(offer.cash?.amount) || 0
  const iPay = cash > 0 && offer.cash?.payer_user_id === viewerId
  const theyPay = cash > 0 && !iPay
  const goneText = item => {
    const problem = gone.get(item.id)
    if (!problem) return null
    if (problem.reason === 'variant') return fill(t('swaps.otherVariantOnly'), { offer: problem.offer_variant })
    return t(item.gives ? 'swaps.notInYourCollection' : 'swaps.notInTheirs').replace('{name}', partner)
  }
  const addedBy = (item) => (added.has(item.collection_item_id) ? partner : null)
  return (
    <div className="grid grid-cols-2 items-start gap-3">
      <section aria-labelledby="swap-get-h" className="flex min-w-0 flex-col gap-2.5 rounded-xl bg-card p-3">
        <h2 id="swap-get-h" className="text-footnote text-text-secondary">
          {fill(t(past ? 'swaps.youGotFrom' : 'swaps.youGetFrom'), { name: partner })}
        </h2>
        {gets.map(item => (
          <SideCard key={item.id} item={item} past={past} added={addedBy(item)} unavailable={goneText(item)} onOpenCard={onOpenCard} />
        ))}
        {theyPay && <CashLine amount={cash} who="them" />}
      </section>
      <section aria-labelledby="swap-give-h" className="flex min-w-0 flex-col gap-2.5 rounded-xl bg-card p-3">
        <h2 id="swap-give-h" className="text-footnote text-text-secondary">{t(past ? 'swaps.youGave' : 'swaps.youGive')}</h2>
        {gives.map(item => (
          <SideCard key={item.id} item={item} past={past} added={addedBy(item)} unavailable={goneText(item)} onOpenCard={onOpenCard} />
        ))}
        {iPay && <CashLine amount={cash} who="me" />}
      </section>
    </div>
  )
}

/** Partner avatar, a swap arrow, your avatar, the title, the status chip with its dates, and the note. */
export function SwapHeader({ offer, me, dates, note }) {
  const { t } = useSettings()
  const partner = offer.partner?.username ?? ''
  const ended = !isOpen(offer) && offer.state !== 'accepted' && offer.state !== 'completed'
  return (
    <header className="flex flex-col items-center text-center">
      <div aria-hidden="true" className="flex items-center gap-3">
        <TrainerAvatar avatarId={offer.partner?.avatar_id} size={48} />
        <span className="grid h-9 w-9 place-items-center rounded-full bg-fill-tertiary">
          <ArrowLeftRight size={18} strokeWidth={2} className={ended ? 'text-text-secondary' : 'text-tint'} />
        </span>
        <TrainerAvatar avatarId={me?.avatar_id} size={48} />
      </div>
      <h1 className="mt-2 text-title-3">{fill(t('swaps.swapWith'), { name: partner })}</h1>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5">
        <SwapStatusChip offer={offer} />
        <span className="text-footnote text-text-secondary">{dates}</span>
      </div>
      {note && <p className="mt-1.5 max-w-[330px] text-footnote text-text-secondary">{note}</p>}
    </header>
  )
}

function ConfirmLine({ name, confirmed, strong, avatar }) {
  const { t } = useSettings()
  return (
    <li className="flex min-h-[32px] items-center gap-2.5">
      <TrainerAvatar avatarId={avatar} size={28} />
      <span className="flex-1 text-subheadline font-semibold">{name}</span>
      {confirmed ? (
        <span className="inline-flex items-center gap-1.5 text-footnote font-semibold text-green">
          <span aria-hidden="true" className="grid h-5 w-5 place-items-center rounded-full bg-green text-black"><Check size={12} strokeWidth={3.5} /></span>
          {t('swaps.swapped')}
        </span>
      ) : (
        <span className="text-footnote text-text-secondary">{strong ? t('swaps.notYet') : t('swaps.notYet')}</span>
      )}
    </li>
  )
}

/** "Swap the cards, then tap Swapped" with both trainers' state (docs/SOCIAL_DESIGN.md §5.5.4). */
export function SwappedStep({ offer, me, onSwapped, busy, offline }) {
  const { t } = useSettings()
  const partner = offer.partner?.username ?? ''
  const gets = sideItems(offer, false).map(item => item.card_name).join(', ')
  const gives = sideItems(offer, true).map(item => item.card_name).join(', ')
  const body = fill(t('swaps.swappedBody'), { get: gets || t('swaps.noCards'), give: gives || t('swaps.noCards'), name: partner })
  return (
    <section aria-labelledby="swap-step-h" className="rounded-xl bg-card p-4">
      <h2 id="swap-step-h" className="text-headline">{t('swaps.swappedTitle')}</h2>
      <p className="mt-1 text-subheadline text-text-secondary">{body}</p>
      <ul className="mt-3 flex flex-col gap-2" aria-live="polite">
        <ConfirmLine name={t('swaps.you')} confirmed={offer.you_confirmed} avatar={me?.avatar_id} />
        <ConfirmLine name={partner} confirmed={offer.partner_confirmed} avatar={offer.partner?.avatar_id} />
      </ul>
      <Button
        size="lg"
        full
        className="mt-3"
        disabled={offer.you_confirmed || offline}
        loading={busy}
        onClick={onSwapped}
      >
        {offer.you_confirmed ? fill(t('swaps.waitingFor'), { name: partner }) : t('swaps.swapped')}
      </Button>
      {offline && <p className="mt-1.5 text-center text-footnote text-text-secondary">{t('swaps.needsConnection')}</p>}
    </section>
  )
}

/** One sentence for each card that is gone (docs/SOCIAL_DESIGN.md §5.5.6). */
export function problemSentence(problem, viewerId, partnerName, offer, t) {
  const item = (offer?.items ?? []).find(entry => entry.id === problem.item_id)
  const name = item ? `${problem.card_name} · ${[item.set_code || item.set_id?.toUpperCase(), item.card_number].filter(Boolean).join(' ')}` : problem.card_name
  const mine = problem.giver_user_id === viewerId
  if (problem.reason === 'variant' && problem.have_variants?.length) {
    return fill(t(mine ? 'swaps.problemVariantMine' : 'swaps.problemVariantTheirs'), {
      name, partner: partnerName, have: problem.have_variants.join(' / '), offer: problem.offer_variant,
    })
  }
  if (problem.available > 0) {
    return fill(t(mine ? 'swaps.problemShortMine' : 'swaps.problemShortTheirs'), {
      name, available: problem.available, needed: problem.needed, partner: partnerName,
    })
  }
  return fill(t(mine ? 'swaps.problemGoneMine' : 'swaps.problemGoneTheirs'), { name, partner: partnerName })
}

export function SwapProblemCard({ offer, unavailable, viewerId, onRetry, onCancel, cancelLabel, busy, offline }) {
  const { t } = useSettings()
  const partner = offer.partner?.username ?? ''
  return (
    <section role="alert" aria-labelledby="swap-problem-h" className="rounded-xl bg-card p-4">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="grid h-[29px] w-[29px] flex-shrink-0 place-items-center rounded-[7px] bg-red text-white">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>
        </span>
        <h2 id="swap-problem-h" className="text-headline">{t('swaps.problemTitle')}</h2>
      </div>
      {unavailable.map(problem => (
        <p key={problem.item_id} className="mt-2 text-subheadline">{problemSentence(problem, viewerId, partner, offer, t)}</p>
      ))}
      <p className="mt-1.5 text-footnote text-text-secondary">{t('swaps.problemHint')}</p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {onRetry && <Button variant="gray" size="md" loading={busy} disabled={offline} onClick={onRetry}>{t('swaps.tryAgain')}</Button>}
        {onCancel && <Button variant="plain" size="md" destructive disabled={offline} onClick={onCancel}>{cancelLabel ?? t('swaps.cancelSwap')}</Button>}
      </div>
    </section>
  )
}

/** The wishlist heart used in rows and the picker. */
export function WishlistHeart({ size = 12 }) {
  return <Heart size={size} fill="#EF6FAE" stroke="#EF6FAE" strokeWidth={2} aria-hidden="true" />
}
