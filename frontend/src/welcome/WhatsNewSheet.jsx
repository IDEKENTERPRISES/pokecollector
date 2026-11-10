import { useSettings } from '../contexts/SettingsContext'
import Button from '../components/ios/Button'
import PageSheet from '../components/ios/PageSheet'
import ReleaseBlock from './ReleaseBlock'
import { sheetBlocks } from './releases'

/**
 * The What's new sheet (docs/WELCOME_DESIGN.md §5.2): one block per missed release, newest first, at
 * most five (the rest fold into "…and N earlier releases"), and a footer link to the full history.
 * Done, a swipe down and the backdrop all call `onClose`; "See everything" calls `onSeeAll`.
 */
export default function WhatsNewSheet({ isOpen, onClose, onSeeAll, releases }) {
  const { t } = useSettings()
  const { shown, folded } = sheetBlocks(releases)
  return (
    <PageSheet
      isOpen={isOpen}
      onClose={onClose}
      title={t('welcome.whatsNew')}
      opaque
      leading={<span />}
      trailing={{ label: t('welcome.done'), onPress: onClose }}
      footer={<Button variant="gray" size="lg" full onClick={onSeeAll} data-testid="whats-new-see-all">{t('welcome.seeEverything')}</Button>}
    >
      <div data-testid="whats-new-sheet">
        {shown.map((release, index) => <ReleaseBlock key={release.id} release={release} first={index === 0} />)}
        {folded > 0 && (
          <button
            type="button"
            onClick={onSeeAll}
            data-testid="whats-new-earlier"
            className="ios-press flex min-h-[44px] w-full items-center border-t-[0.5px] border-border px-4 text-left text-subheadline text-tint"
          >
            {t(folded === 1 ? 'welcome.earlierOne' : 'welcome.earlier').replace('{count}', folded)}
          </button>
        )}
      </div>
    </PageSheet>
  )
}
