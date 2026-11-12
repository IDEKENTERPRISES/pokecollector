import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { dismissBanner, getActiveBanners } from '../../api/banners'
import { useSettings } from '../../contexts/SettingsContext'
import BannerView, { MAX_VISIBLE_BANNERS, overflowCount } from './BannerView'

export const ACTIVE_BANNERS_QUERY_KEY = ['banners', 'active']

/** Pure view of the stack, so it can be unit-tested without a query client. */
export function BannerStack({ banners, onDismiss }) {
  const { t } = useSettings()
  if (!banners.length) return null
  const more = overflowCount(banners)
  return (
    <section className="space-y-2" data-testid="home-banners" aria-label={t('banners.homeLabel')}>
      {banners.slice(0, MAX_VISIBLE_BANNERS).map(banner => (
        <BannerView key={banner.id} banner={banner} onDismiss={onDismiss} />
      ))}
      {more > 0 && (
        <p className="px-1 text-footnote text-text-secondary" data-testid="banners-more">
          {t('banners.more').replace('{count}', more)}
        </p>
      )}
    </section>
  )
}

/** Home's admin banners: newest first, at most three, dismissals saved on the server. */
export default function HomeBanners() {
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: ACTIVE_BANNERS_QUERY_KEY,
    queryFn: getActiveBanners,
    staleTime: 60 * 1000,
  })
  const dismiss = useMutation({
    mutationFn: banner => dismissBanner(banner.id),
    onMutate: banner => {
      queryClient.setQueryData(ACTIVE_BANNERS_QUERY_KEY, old => (
        old ? { ...old, banners: old.banners.filter(b => b.id !== banner.id) } : old
      ))
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ACTIVE_BANNERS_QUERY_KEY }),
  })
  return <BannerStack banners={data?.banners ?? []} onDismiss={banner => dismiss.mutate(banner)} />
}
