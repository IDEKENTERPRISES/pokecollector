import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getScanJobs, getSwapsWaiting } from '../../api/client'
import { useAuth } from '../../contexts/AuthContext'
import { setAppBadge } from '../../pwa/appBadge'
import { SCAN_JOBS_QUERY_KEY, hasActiveScanJobs, scanAttentionCount } from '../../utils/scanJobs'
import { SWAPS_WAITING_QUERY_KEY, appIconNumber, useSocialEnabled } from '../../social/social'

// Keeps the app icon number equal to the scans waiting for review plus (social on) the swap offers
// waiting for you: on start, whenever those queries change, and when the app comes back to the
// foreground. Renders nothing.
export default function AppBadgeSync() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const signedIn = Boolean(user)
  const socialOn = useSocialEnabled() && signedIn
  const { data } = useQuery({
    queryKey: SCAN_JOBS_QUERY_KEY,
    queryFn: getScanJobs,
    enabled: signedIn,
    staleTime: 15000,
    retry: 1,
    refetchInterval: query => (hasActiveScanJobs(query.state.data?.jobs || []) ? 3000 : false),
  })
  const { data: swaps, isFetched: swapsFetched } = useQuery({
    queryKey: SWAPS_WAITING_QUERY_KEY,
    queryFn: getSwapsWaiting,
    enabled: socialOn,
    staleTime: 15000,
    retry: 1,
  })
  const attention = appIconNumber(signedIn ? scanAttentionCount(data?.jobs || []) : 0, swaps?.count, socialOn)
  const loaded = (!signedIn || data !== undefined) && (!socialOn || swapsFetched)

  useEffect(() => {
    if (loaded) setAppBadge(attention)
  }, [attention, loaded])

  useEffect(() => {
    if (!signedIn) return undefined
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      queryClient.invalidateQueries({ queryKey: SCAN_JOBS_QUERY_KEY })
      if (socialOn) queryClient.invalidateQueries({ queryKey: SWAPS_WAITING_QUERY_KEY })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [signedIn, socialOn, queryClient])

  return null
}
