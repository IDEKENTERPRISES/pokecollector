import { useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Check, ChevronRight, Layers, ArrowLeftRight } from 'lucide-react'
import clsx from 'clsx'
import Alert from '../components/ios/Alert'
import Button from '../components/ios/Button'
import HideValuesToggle from '../components/ios/HideValuesToggle'
import { CardModal } from '../components/CardItem'
import { useSettings } from '../contexts/SettingsContext'
import { useAuth } from '../contexts/AuthContext'
import { useOffline } from '../offline/useOffline'
import { useNavBar } from '../navigation/useNavBar'
import {
  acceptSwap, cancelSwap, confirmSwapped, declineSwap, getApiErrorMessage, getSwap,
} from '../api/client'
import { SWAPS_QUERY_KEY, SWAPS_WAITING_QUERY_KEY, useSocialGate } from '../social/social'
import {
  FairTradeMeter, SwapHeader, SwapProblemCard, SwapSides, SwappedStep,
} from '../social/SwapParts'
import { useSwapStarter } from '../social/SwapStarter'
import {
  clockTime, daysLeft, dayMonth, isOpen, isSameDay, minutesAgo,
} from '../social/swapHelpers'

const NAV_BAR = { trailing: <HideValuesToggle /> }

const fill = (text, values) => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, value), text)

function ago(t, value) {
  const minutes = minutesAgo(value)
  if (minutes == null) return ''
  if (minutes < 1) return t('swaps.justNow')
  if (minutes < 60) return fill(t('swaps.agoMinutes'), { count: minutes })
  if (minutes < 1440) return fill(t('swaps.agoHours'), { count: Math.floor(minutes / 60) })
  const days = Math.floor(minutes / 1440)
  return days === 1 ? t('swaps.yesterday') : fill(t('swaps.agoDays'), { count: days })
}

function expires(t, offer) {
  const left = daysLeft(offer.expires_at)
  if (left == null) return ''
  if (left === 0) return t('swaps.expiresToday')
  return fill(t(left === 1 ? 'swaps.expiresInOne' : 'swaps.expiresIn'), { count: left })
}

/** The line beside the status chip (docs/SOCIAL_DESIGN.md §5.5). */
export function datesLine(t, offer, unavailable) {
  const partner = offer.partner?.username ?? ''
  if (isOpen(offer)) {
    const verb = offer.revision > 1 ? 'swaps.changed' : 'swaps.sent'
    return `${fill(t(verb), { age: ago(t, offer.revision > 1 ? offer.updated_at : offer.created_at) })} · ${expires(t, offer)}`
  }
  if (offer.state === 'accepted') {
    if (unavailable.length && offer.partner_confirmed) return `${fill(t('swaps.partnerTapped'), { name: partner })} · ${expires(t, offer)}`
    return `${fill(t('swaps.acceptedAgo'), { age: ago(t, offer.updated_at) })} · ${expires(t, offer)}`
  }
  if (offer.state === 'completed') {
    const when = offer.completed_at
    return isSameDay(when)
      ? fill(t('swaps.todayAt'), { time: clockTime(when) })
      : fill(t('swaps.dateAt'), { date: dayMonth(when), time: clockTime(when) })
  }
  return fill(t(offer.role === 'proposer' ? 'swaps.youSentOn' : 'swaps.theySentOn'), { name: partner, date: dayMonth(offer.created_at) })
}

function noteLine(t, offer, viewerId) {
  if (!offer.note || !isOpen(offer)) return null
  const author = offer.revision % 2 === 1 ? offer.from_user : offer.to_user
  return author?.id === viewerId
    ? fill(t('swaps.yourNote'), { note: offer.note })
    : fill(t('swaps.theirNote'), { name: author?.username ?? '', note: offer.note })
}

function changeSentence(t, change, partnerName) {
  const name = [change.card_name, [change.set_code || change.set_id?.toUpperCase(), change.card_number].filter(Boolean).join(' ')].filter(Boolean).join(' · ')
  const where = t(change.gives ? 'swaps.toWhatYouGive' : 'swaps.toWhatYouGet')
  switch (change.change) {
    case 'added': return fill(t('swaps.changeAdded'), { name, where })
    case 'removed': return fill(t('swaps.changeRemoved'), { name, where: t(change.gives ? 'swaps.fromWhatYouGive' : 'swaps.fromWhatYouGet') })
    case 'quantity': return fill(t('swaps.changeQuantity'), { name: change.card_name, from: change.from, to: change.to })
    case 'cash': return t('swaps.changeCash')
    case 'note': return t('swaps.changeNote')
    default: return partnerName
  }
}

function WhatChanged({ offer, t }) {
  const partner = offer.partner?.username ?? ''
  const changes = offer.changes ?? []
  return (
    <section aria-labelledby="swap-changed-h" className="flex items-center gap-3 rounded-xl bg-card px-4 py-3">
      <span aria-hidden="true" className="grid h-[29px] w-[29px] flex-shrink-0 place-items-center rounded-[7px] bg-accent/20 text-tint">
        <ArrowLeftRight size={18} strokeWidth={1.9} />
      </span>
      <div className="min-w-0">
        <h2 id="swap-changed-h" className="text-headline">{fill(t('swaps.changedTitle'), { name: partner })}</h2>
        {changes.length ? changes.map((change, index) => (
          <p key={index} className="text-footnote text-text-secondary">{changeSentence(t, { ...change, set_code: change.set_code }, partner)}</p>
        )) : <p className="text-footnote text-text-secondary">{t('swaps.changedUnknown')}</p>}
      </div>
    </section>
  )
}

function SuccessCard({ offer, t }) {
  return (
    <section aria-labelledby="swap-done-h" className="flex flex-col items-center rounded-xl bg-card p-4 text-center">
      <span aria-hidden="true" className="swap-check-in grid h-16 w-16 place-items-center rounded-full bg-green text-black">
        <Check size={34} strokeWidth={3} />
      </span>
      <h2 id="swap-done-h" className="mt-3 text-title-3">{fill(t('swaps.swappedOn'), { date: dayMonth(offer.completed_at) })}</h2>
      <p className="mt-1 text-subheadline text-text-secondary">{t('swaps.swappedBodyDone')}</p>
    </section>
  )
}

function LinkRow({ to, color, icon: Icon, title, last }) {
  const navigate = useNavigate()
  return (
    <button
      type="button"
      onClick={() => navigate(to)}
      className={clsx(
        'relative flex min-h-[44px] w-full items-center gap-3 px-4 py-[11px] text-left active:bg-elevated',
        !last && 'after:pointer-events-none after:absolute after:bottom-0 after:left-[57px] after:right-0 after:h-[0.5px] after:bg-border',
      )}
    >
      <span aria-hidden="true" className="grid h-[29px] w-[29px] flex-shrink-0 place-items-center rounded-[7px] text-white" style={{ background: color }}>
        <Icon size={18} strokeWidth={1.9} />
      </span>
      <span className="flex-1 text-body">{title}</span>
      <ChevronRight size={18} strokeWidth={2.25} className="flex-shrink-0 text-text-tertiary" aria-hidden="true" />
    </button>
  )
}

/** /trades/offers/:offerId: one swap offer in whatever state it is in (docs/SOCIAL_DESIGN.md §5.5). */
export default function SwapOffer() {
  const { offerId } = useParams()
  useNavBar(NAV_BAR)
  const gate = useSocialGate()
  const social = gate === 'on'
  const { t } = useSettings()
  const { user } = useAuth()
  const offline = useOffline()
  const queryClient = useQueryClient()
  const { start, element } = useSwapStarter()
  const [confirming, setConfirming] = useState(null) // 'decline' | 'cancel'
  const [problems, setProblems] = useState(null)
  const [openedCard, setOpenedCard] = useState(null)
  const queryKey = [...SWAPS_QUERY_KEY, Number(offerId)]
  const { data: offer, isLoading, error, refetch } = useQuery({
    queryKey,
    queryFn: () => getSwap(offerId),
    enabled: social,
  })

  const refresh = (next) => {
    if (next) queryClient.setQueryData(queryKey, next)
    queryClient.invalidateQueries({ queryKey: SWAPS_QUERY_KEY })
    queryClient.invalidateQueries({ queryKey: SWAPS_WAITING_QUERY_KEY })
  }
  const act = useMutation({
    mutationFn: ({ action }) => {
      if (action === 'accept') return acceptSwap(offerId, offer.revision)
      if (action === 'decline') return declineSwap(offerId, offer.revision)
      if (action === 'cancel') return cancelSwap(offerId)
      return confirmSwapped(offerId)
    },
    onSuccess: (next) => { setProblems(null); refresh(next) },
    onError: (failure) => {
      const unavailable = failure?.response?.data?.unavailable
      if (failure?.response?.status === 409 && Array.isArray(unavailable) && unavailable.length) {
        setProblems(unavailable)
        refresh()
        return
      }
      toast.error(getApiErrorMessage(failure, t('common.error')))
      refetch()
    },
  })

  if (gate === 'off') return <Navigate to="/trades" replace />
  if (gate === 'wait' || isLoading) {
    return <div className="flex flex-col gap-3 pt-2"><div className="skeleton mx-auto h-24 w-48 rounded-xl" /><div className="skeleton h-40 rounded-xl" /></div>
  }
  if (error || !offer) {
    return <div className="card text-sm text-red" role="alert">{t('swaps.loadOneFailed')}</div>
  }

  const viewerId = user?.id
  const partner = offer.partner?.username ?? ''
  const unavailable = problems ?? offer.unavailable ?? []
  const actions = offer.actions ?? []
  const open = isOpen(offer)
  const ended = !open && !['accepted', 'completed'].includes(offer.state)
  const past = !open && offer.state !== 'accepted'
  const gives = (offer.values?.you?.gives) ?? 0
  const gets = (offer.values?.you?.gets) ?? 0
  const run = (action) => act.mutate({ action })
  const blockedOnOpen = open && unavailable.length > 0 // for both trainers; only the receiver's Accept is held back
  const openCard = item => setOpenedCard({ ...item, id: item.card_id, name: item.card_name })

  const endedSentence = () => {
    const date = dayMonth(offer.updated_at)
    if (offer.state === 'declined') return fill(t('swaps.endedDeclined'), { name: partner, date })
    if (offer.state === 'cancelled') {
      return fill(t(offer.role === 'proposer' ? 'swaps.endedCancelledYou' : 'swaps.endedCancelledThem'), { name: partner, date })
    }
    return fill(t('swaps.endedExpired'), { date })
  }

  return (
    <div className="flex flex-col gap-3 pt-2" data-testid="swap-offer" data-state={offer.state}>
      <SwapHeader
        offer={{ ...offer, unavailable }}
        me={user}
        dates={datesLine(t, offer, unavailable)}
        note={noteLine(t, offer, viewerId)}
      />

      {open && offer.your_turn && offer.revision > 1 && <WhatChanged offer={offer} t={t} />}

      {offer.state === 'accepted' && unavailable.length === 0 && (
        <SwappedStep
          offer={offer}
          me={user}
          busy={act.isPending && act.variables?.action === 'confirm'}
          offline={offline}
          onSwapped={() => run('confirm')}
        />
      )}
      {offer.state === 'accepted' && unavailable.length > 0 && (
        <SwapProblemCard
          offer={offer}
          unavailable={unavailable}
          viewerId={viewerId}
          busy={act.isPending && act.variables?.action === 'confirm'}
          offline={offline}
          onRetry={offer.you_confirmed ? undefined : () => run('confirm')}
          onCancel={() => setConfirming('cancel')}
        />
      )}
      {blockedOnOpen && (
        <SwapProblemCard
          offer={offer}
          unavailable={unavailable}
          viewerId={viewerId}
          offline={offline}
          onCancel={actions.includes('decline') ? () => setConfirming('decline') : actions.includes('cancel') ? () => setConfirming('cancel') : undefined}
          cancelLabel={t(actions.includes('decline') ? 'swaps.decline' : 'swaps.cancelOffer')}
        />
      )}
      {offer.state === 'completed' && <SuccessCard offer={offer} t={t} />}
      {offer.state === 'completed' && (
        <div className="overflow-hidden rounded-xl bg-card">
          <LinkRow
            to={`/collection?cardId=${encodeURIComponent((offer.items.find(item => !item.gives) ?? offer.items[0])?.card_id ?? '')}`}
            color="var(--color-blue)"
            icon={Layers}
            title={fill(t('swaps.inCollection'), { name: (offer.items.find(item => !item.gives) ?? offer.items[0])?.card_name ?? '' })}
          />
          <LinkRow to={`/trades?trade=${offer.trade_id ?? ''}`} color="var(--color-green)" icon={ArrowLeftRight} title={t('swaps.openTradeHistory')} last />
        </div>
      )}
      {ended && (
        <section className="flex flex-col gap-3 rounded-xl bg-card p-4">
          <p className="text-body">{endedSentence()}</p>
          <Button
            variant="gray"
            size="md"
            full
            disabled={offline}
            onClick={() => start(offer.partner, null, { mode: 'again', offer, skipNudge: true })}
          >
            {t(offer.state === 'expired' ? 'swaps.sendAgain' : 'swaps.sendNew')}
          </Button>
        </section>
      )}

      <SwapSides offer={offer} viewerId={viewerId} past={past} unavailable={offer.state === 'accepted' || blockedOnOpen ? unavailable : []} onOpenCard={openCard} />

      {open && (
        <FairTradeMeter gives={gives} gets={gets} missingPrices={offer.values?.you?.missing_prices ?? 0} />
      )}

      {open && (
        <div className="mt-1 flex flex-col gap-3">
          {actions.includes('accept') && !blockedOnOpen && (
            <Button size="lg" full loading={act.isPending && act.variables?.action === 'accept'} disabled={offline} onClick={() => run('accept')}>{t('swaps.accept')}</Button>
          )}
          {(actions.includes('counter') || actions.includes('decline')) && (
            <div className="grid grid-cols-2 gap-3">
              {actions.includes('counter') && <Button variant="gray" size="md" disabled={offline} onClick={() => start(offer.partner, null, { mode: 'counter', offer, skipNudge: true })}>{t('swaps.counter')}</Button>}
              {actions.includes('decline') && <Button variant="gray" size="md" destructive disabled={offline} onClick={() => setConfirming('decline')}>{t('swaps.decline')}</Button>}
            </div>
          )}
          {actions.includes('cancel') && !actions.includes('decline') && (
            <Button variant="gray" size="lg" full destructive disabled={offline} onClick={() => setConfirming('cancel')}>{t('swaps.cancelOffer')}</Button>
          )}
          {offline && <p className="text-center text-footnote text-text-secondary">{t('swaps.needsConnection')}</p>}
        </div>
      )}
      {offer.state === 'accepted' && actions.includes('cancel') && unavailable.length === 0 && (
        <Button variant="gray" size="md" full destructive disabled={offline} onClick={() => setConfirming('cancel')}>{t('swaps.cancelSwap')}</Button>
      )}
      {offer.state === 'completed' && (
        <Button variant="gray" size="lg" full disabled={offline} onClick={() => start(offer.partner)}>
          {fill(t('swaps.offerAnother'), { name: partner })}
        </Button>
      )}

      <Alert
        isOpen={confirming === 'decline'}
        onClose={() => setConfirming(null)}
        title={fill(t('swaps.declineTitle'), { name: partner })}
        message={t('swaps.declineMessage')}
        actions={[
          { label: t('common.cancel'), style: 'cancel', onSelect: () => setConfirming(null) },
          { label: t('swaps.decline'), style: 'destructive', onSelect: () => { setConfirming(null); run('decline') } },
        ]}
      />
      <Alert
        isOpen={confirming === 'cancel'}
        onClose={() => setConfirming(null)}
        title={t(offer.state === 'accepted' ? 'swaps.cancelSwapTitle' : 'swaps.cancelOfferTitle')}
        message={t(offer.state === 'accepted' ? 'swaps.cancelSwapMessage' : 'swaps.cancelOfferMessage')}
        actions={[
          { label: t('swaps.keepIt'), style: 'cancel', onSelect: () => setConfirming(null) },
          { label: t(offer.state === 'accepted' ? 'swaps.cancelSwap' : 'swaps.cancelOffer'), style: 'destructive', onSelect: () => { setConfirming(null); run('cancel') } },
        ]}
      />
      {openedCard && <CardModal card={openedCard} onClose={() => setOpenedCard(null)} />}
      {element}
      <span className="sr-only" aria-live="polite">{offer.you_confirmed && offer.state === 'accepted' ? fill(t('swaps.waitingFor'), { name: partner }) : ''}</span>
    </div>
  )
}
