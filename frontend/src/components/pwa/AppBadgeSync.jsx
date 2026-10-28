import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getScanJobs } from '../../api/client'
import { useAuth } from '../../contexts/AuthContext'
import { setAppBadge } from '../../pwa/appBadge'
import { SCAN_JOBS_QUERY_KEY, hasActiveScanJobs, scanAttentionCount } from '../../utils/scanJobs'

// Keeps the app icon number equal to the scans waiting for review: on start, whenever the scan-jobs
// query changes, and when the app comes back to the foreground. Renders nothing.
export default function AppBadgeSync() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const signedIn = Boolean(user)
  const { data } = useQuery({
    queryKey: SCAN_JOBS_QUERY_KEY,
    queryFn: getScanJobs,
    enabled: signedIn,
    staleTime: 15000,
    retry: 1,
    refetchInterval: query => (hasActiveScanJobs(query.state.data?.jobs || []) ? 3000 : false),
  })
  const attention = signedIn ? scanAttentionCount(data?.jobs || []) : 0
  const loaded = !signedIn || data !== undefined

  useEffect(() => {
    if (loaded) setAppBadge(attention)
  }, [attention, loaded])

  useEffect(() => {
    if (!signedIn) return undefined
    const onVisible = () => {
      if (document.visibilityState === 'visible') queryClient.invalidateQueries({ queryKey: SCAN_JOBS_QUERY_KEY })
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [signedIn, queryClient])

  return null
}
