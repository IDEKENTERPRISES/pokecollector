import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import api from '../../api/client'
import { fill } from './format'

const QUERY_KEY = ['pokedex-splash-cache']

/**
 * Settings › Data & sync, admins only: fill the server's splash cache (every species' Pokédex
 * extras and sprite) in the background, at a polite rate (backend/services/pokedex_splash.py).
 * Without it the cache still grows by about one species per launch.
 */
export default function SplashCacheSection({ t }) {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.get('/pokedex/splash/cache').then(response => response.data),
    refetchInterval: query => (query.state.data?.running ? 3000 : false),
  })
  const start = useMutation({
    mutationFn: () => api.post('/pokedex/splash/cache').then(response => response.data),
    onSuccess: state => queryClient.setQueryData(QUERY_KEY, state),
  })
  const total = data?.total ?? 1025
  const cached = data?.cached ?? 0
  const running = Boolean(data?.running)
  const complete = !running && cached >= total

  return (
    <section className="space-y-1">
      <h2 className="px-4 pb-1.5 text-footnote text-text-secondary">{t('splash.cacheTitle')}</h2>
      <div className="overflow-hidden rounded-xl bg-card">
        <div className="flex min-h-[44px] items-center justify-between gap-3 px-4 py-[11px]">
          <p className="min-w-0 flex-1 text-footnote text-text-secondary" aria-live="polite">
            {running
              ? fill(t('splash.cacheRunning'), { done: data?.done ?? 0, total })
              : fill(t('splash.cacheDesc'), { cached, total })}
          </p>
          <button
            type="button"
            onClick={() => start.mutate()}
            disabled={running || complete || start.isPending}
            className="inline-flex min-h-[32px] flex-shrink-0 items-center gap-1.5 rounded-full bg-accent/20 px-3.5 text-subheadline font-semibold text-tint ios-press disabled:opacity-40"
          >
            <Download size={13} aria-hidden="true" />
            {complete ? t('splash.cacheDone') : t('splash.cacheStart')}
          </button>
        </div>
      </div>
    </section>
  )
}
