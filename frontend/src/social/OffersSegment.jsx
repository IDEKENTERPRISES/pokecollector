import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import ActionSheet from '../components/ios/ActionSheet'
import Button from '../components/ios/Button'
import PokeBall from '../components/ios/PokeBall'
import { useSettings } from '../contexts/SettingsContext'
import { useAuth } from '../contexts/AuthContext'
import { useOffline } from '../offline/useOffline'
import { getLeaderboard, getSwaps } from '../api/client'
import { SWAPS_QUERY_KEY } from './social'
import { SwapOfferRow } from './SwapParts'
import { useSwapStarter } from './SwapStarter'
import { groupOffers } from './swapHelpers'

const fill = (text, values) => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, value), text)

function Section({ header, footer, offers }) {
  if (!offers.length) return null
  return (
    <section>
      <h3 className="px-4 pb-1.5 text-footnote text-text-secondary">{header}</h3>
      <div className="overflow-hidden rounded-xl bg-card">
        {offers.map(offer => <SwapOfferRow key={offer.id} offer={offer} />)}
      </div>
      {footer && <p className="px-4 pt-1.5 text-footnote text-text-secondary">{footer}</p>}
    </section>
  )
}

/** The Offers segment of Trades (docs/SOCIAL_DESIGN.md §5.3). */
export default function OffersSegment() {
  const { t, pricePrimaryField } = useSettings()
  const { user } = useAuth()
  const navigate = useNavigate()
  const offline = useOffline()
  const [picking, setPicking] = useState(false)
  const { start, element } = useSwapStarter()
  const { data, isLoading, error } = useQuery({ queryKey: SWAPS_QUERY_KEY, queryFn: getSwaps })
  const trainers = useQuery({
    queryKey: ['leaderboard', pricePrimaryField],
    queryFn: () => getLeaderboard({ price_field: pricePrimaryField }).then(response => response.data),
    enabled: picking,
  })
  const groups = useMemo(() => groupOffers(data), [data])
  const empty = data && !groups.yourTurn.length && !groups.accepted.length && !groups.waiting.length && !groups.finished.length

  if (isLoading) {
    return <div className="space-y-4">{[...Array(3)].map((_, index) => <div key={index} className="skeleton h-[76px] rounded-xl" />)}</div>
  }
  if (error && !data) {
    return <div className="card text-sm text-red" role="alert">{t('swaps.loadFailed')}</div>
  }

  const others = (trainers.data ?? []).filter(trainer => trainer.user_id !== user?.id)
  const newOffer = (
    <>
      <Button variant="gray" size="lg" full disabled={offline} onClick={() => setPicking(true)}>{t('swaps.newOffer')}</Button>
      {offline && <p className="-mt-2 text-center text-footnote text-text-secondary">{t('swaps.needsConnection')}</p>}
    </>
  )

  return (
    <div className="flex flex-col gap-4" data-testid="offers-segment">
      {empty ? (
        <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
          <PokeBall size={56} />
          <h2 className="text-title-3">{t('swaps.emptyTitle')}</h2>
          <p className="text-subheadline text-text-secondary">{t('swaps.emptyBody')}</p>
          <Button variant="gray" className="mt-2" onClick={() => navigate('/leaderboard')}>{t('swaps.openLeaderboard')}</Button>
        </div>
      ) : (
        <>
          <Section header={fill(t('swaps.sectionYourTurn'), { count: groups.yourTurn.length })} offers={groups.yourTurn} />
          <Section header={t('swaps.sectionAccepted')} offers={groups.accepted} />
          <Section header={t('swaps.sectionWaiting')} offers={groups.waiting} />
          <Section header={t('swaps.sectionFinished')} footer={t('swaps.finishedFooter')} offers={groups.finished} />
        </>
      )}
      {newOffer}
      <ActionSheet
        isOpen={picking}
        onClose={() => setPicking(false)}
        title={t('swaps.swapWithPrompt')}
        message={trainers.isLoading ? t('common.loading') : (others.length ? undefined : t('swaps.noTrainers'))}
        actions={others.map(trainer => ({
          label: trainer.username,
          onSelect: () => start({ id: trainer.user_id, username: trainer.username, avatar_id: trainer.avatar_id }),
        }))}
      />
      {element}
    </div>
  )
}
