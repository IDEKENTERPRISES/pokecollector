import { useQuery } from '@tanstack/react-query'
import { getWrapped } from '../api/client'
import { useAuth } from '../contexts/AuthContext'

/**
 * The year in review (engagement P9b). The server answers 404 outside 1 December to 15 January (the window is skipped when
 * WRAPPED_PREVIEW is set on nonprod), so `data` is only there while Wrapped is available.
 * The query is read-cached, so a Wrapped that was opened once opens offline too.
 */
export function useWrapped(year) {
  const { user } = useAuth()
  return useQuery({
    queryKey: ['wrapped', user?.id, year],
    queryFn: async () => {
      let data = null
      try {
        data = await getWrapped(year)
      } catch (error) {
        // Outside the window the server answers 404: that is "not available", not a failure, so a
        // pull to refresh does not report an error for it. Network errors still throw (offline keeps the cache).
        if (error?.response?.status !== 404) throw error
      }
      // Anything but a real year in review (an empty body, say) counts as not available.
      return data?.year && data.totals ? data : null
    },
    enabled: Boolean(user?.id),
    staleTime: 10 * 60 * 1000,
    retry: false,
  })
}
