import { useQuery } from '@tanstack/react-query'
import { getWrapped } from '../api/client'
import { useAuth } from '../contexts/AuthContext'

/**
 * The year in review (engagement P9b). The server answers 404 outside 1 December to 15 January (or
 * always, when WRAPPED_PREVIEW is set on nonprod), so `data` is only there while Wrapped is available.
 * The query is read-cached, so a Wrapped that was opened once opens offline too.
 */
export function useWrapped(year) {
  const { user } = useAuth()
  return useQuery({
    queryKey: ['wrapped', user?.id, year],
    queryFn: async () => {
      const data = await getWrapped(year)
      // Anything but a real year in review (an empty body, say) counts as not available.
      if (!data?.year || !data.totals) throw new Error('Wrapped is not available')
      return data
    },
    enabled: Boolean(user?.id),
    staleTime: 10 * 60 * 1000,
    retry: false,
  })
}
