import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import ListRow from '../components/ios/ListRow'
import ListSection from '../components/ios/ListSection'
import { testChoices, writeTestOverride } from './testOverride'

/** Nonprod only (docs/NONPROD.md): pick an older release and the app reloads and opens What's new as if updated from it. */
export default function TestWhatsNew() {
  const { t } = useSettings()
  const { user } = useAuth()
  const pick = (choice) => {
    if (user?.id == null) return
    writeTestOverride(user.id, choice.seen)
    window.location.assign('/')
  }
  return (
    <ListSection header={t('welcome.testHeader')} footer={t('welcome.testFooter')} className="!mx-0" data-testid="test-whats-new">
      {testChoices().map((choice) => (
        <ListRow
          key={choice.key}
          title={t(choice.before ? 'welcome.testBefore' : 'welcome.testAsIfLast').replace('{name}', choice.name)}
          onClick={() => pick(choice)}
          chevron
          testId={`test-whats-new-${choice.key}`}
        />
      ))}
    </ListSection>
  )
}
