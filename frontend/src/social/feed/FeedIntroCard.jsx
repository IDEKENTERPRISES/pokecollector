import { Eye } from 'lucide-react'
import Button from '../../components/ios/Button'
import { useSettings } from '../../contexts/SettingsContext'

/** The first-visit card of the feed (docs/SOCIAL_DESIGN.md §6.5): what you share, with a way to change it. */
export default function FeedIntroCard({ onChange, onDismiss }) {
  const { t } = useSettings()
  return (
    <section aria-labelledby="feed-intro-title" className="rounded-xl bg-card p-4" data-testid="feed-intro">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="grid h-[29px] w-[29px] flex-shrink-0 place-items-center rounded-[7px] bg-blue text-white">
          <Eye size={18} strokeWidth={1.9} />
        </span>
        <div className="min-w-0">
          <h2 id="feed-intro-title" className="text-headline">{t('feed.introTitle')}</h2>
          <p className="mt-1 text-subheadline text-text-secondary">{t('feed.introText')}</p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Button variant="gray" size="md" onClick={onChange}>{t('feed.introChange')}</Button>
        <Button variant="tinted" size="md" onClick={onDismiss}>{t('feed.introOk')}</Button>
      </div>
    </section>
  )
}
