import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import Alert from '../components/ios/Alert'
import { useSettings } from '../contexts/SettingsContext'
import { getSwaps } from '../api/client'
import { SWAPS_QUERY_KEY, useSocialEnabled } from './social'
import SwapComposerSheet from './SwapComposerSheet'
import { isOpen } from './swapHelpers'

const fill = (text, values) => Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, value), text)

/**
 * Starts a swap with a trainer: asks first when an offer with them is already active ("You already have a
 * swap with Misty"), then opens the composer. Returns `start(partner, initial)` and an `element` to render.
 * `partner` is { id, username }.
 */
export function useSwapStarter() {
  const { t } = useSettings()
  const navigate = useNavigate()
  const social = useSocialEnabled()
  const { data } = useQuery({ queryKey: SWAPS_QUERY_KEY, queryFn: getSwaps, enabled: social })
  const [session, setSession] = useState(null) // { partner, initial, mode, offer }
  const [asking, setAsking] = useState(null) // { partner, initial, existing }

  const start = useCallback((partner, initial = null, extra = {}) => {
    if (!partner?.id) return
    if (!extra.skipNudge) {
      const existing = [...(data?.incoming ?? []), ...(data?.outgoing ?? [])]
        .find(offer => offer.partner?.id === partner.id && (isOpen(offer) || offer.state === 'accepted'))
      if (existing) {
        setAsking({ partner, initial, existing })
        return
      }
    }
    setSession({ partner, initial, mode: extra.mode ?? 'new', offer: extra.offer ?? null })
  }, [data])

  const element = (
    <>
      <Alert
        isOpen={Boolean(asking)}
        onClose={() => setAsking(null)}
        title={asking ? fill(t('swaps.alreadyTitle'), { name: asking.partner.username }) : ''}
        message={t('swaps.alreadyMessage')}
        actions={[
          {
            label: t('swaps.openIt'),
            style: 'default',
            preferred: true,
            onSelect: () => { const target = asking.existing.id; setAsking(null); navigate(`/trades/offers/${target}`) },
          },
          {
            label: t('swaps.newOffer'),
            style: 'default',
            onSelect: () => { const next = asking; setAsking(null); setSession({ partner: next.partner, initial: next.initial, mode: 'new', offer: null }) },
          },
        ]}
      />
      {session && (
        <SwapComposerSheet
          isOpen
          onClose={() => setSession(null)}
          partner={session.partner}
          mode={session.mode}
          offer={session.offer}
          initial={session.initial}
        />
      )}
    </>
  )
  return { start, element }
}
