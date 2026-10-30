import toast from 'react-hot-toast'
import ListRow from '../../components/ios/ListRow'
import ListSection from '../../components/ios/ListSection'
import PageSheet from '../../components/ios/PageSheet'
import Switch from '../../components/ios/Switch'
import { useSettings } from '../../contexts/SettingsContext'
import { BIG_PULL_EUR, CHALLENGE_BOARD_KEY, SHARE_ROWS, SHARE_VALUES_KEY, isOn } from './feedFormat'

const LABEL_KEYS = {
  set_completed: 'feed.sharingSetCompleted',
  achievement_unlocked: 'feed.sharingAchievement',
  big_pull: 'feed.sharingBigPull',
  goal_completed: 'feed.sharingGoal',
  challenge_finished: 'feed.sharingChallenge',
}

/**
 * "What you share" (docs/SOCIAL_DESIGN.md §6.4): one switch per kind of event, whether card values go
 * with them, and whether you show on the weekly challenge board. Each switch saves at once.
 * The challenge rows appear once the server reports their keys (P13).
 */
export default function SharingSheet({ isOpen, onClose }) {
  const { t, settings, updateSettings, currencySymbol, exchangeRate } = useSettings()

  const save = (key, value) => {
    updateSettings({ [key]: value ? 'true' : 'false' }).catch(() => toast.error(t('feed.sharingSaveFailed')))
  }
  const row = (key, fallback, title, subtitle) => (
    <ListRow
      key={key}
      title={title}
      subtitle={subtitle}
      trailing={<Switch label={title} checked={isOn(settings, key, fallback)} onChange={value => save(key, value)} />}
    />
  )
  // A threshold is not a trainer's amount, so it shows even while values are hidden.
  const threshold = `${currencySymbol}${(BIG_PULL_EUR * exchangeRate).toFixed(2)}`
  const hasBoard = settings?.[CHALLENGE_BOARD_KEY] !== undefined
  const rows = SHARE_ROWS.filter(({ key, needsServerKey }) => !needsServerKey || settings?.[key] !== undefined)

  return (
    <PageSheet
      isOpen={isOpen}
      onClose={onClose}
      title={t('feed.sharingTitle')}
      leading={<span />}
      trailing={{ label: t('feed.sharingDone'), onPress: onClose }}
    >
      <div className="flex flex-col gap-5 px-4 pb-[34px] pt-4">
        <ListSection className="!mx-0" header={t('feed.sharingKinds')}>
          {rows.map(({ kind, key, fallback }) => row(
            key,
            fallback,
            t(LABEL_KEYS[kind]),
            kind === 'big_pull' ? t('feed.sharingBigPullHint').replace('{amount}', threshold) : undefined,
          ))}
        </ListSection>
        <ListSection className="!mx-0" header={t('feed.sharingAmounts')} footer={t('feed.sharingValuesFooter')}>
          {row(SHARE_VALUES_KEY, false, t('feed.sharingValues'))}
        </ListSection>
        {hasBoard && (
          <ListSection className="!mx-0" header={t('feed.sharingBoard')} footer={t('feed.sharingBoardFooter')}>
            {row(CHALLENGE_BOARD_KEY, true, t('feed.sharingOnBoard'))}
          </ListSection>
        )}
        <p className="px-4 text-footnote text-text-secondary">{t('feed.sharingFooter')}</p>
      </div>
    </PageSheet>
  )
}
