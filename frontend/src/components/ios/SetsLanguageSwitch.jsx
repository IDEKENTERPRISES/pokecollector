import { ChevronDown } from 'lucide-react'
import { useSettings } from '../../contexts/SettingsContext'
import { getTcgdexLanguage } from '../../utils/tcgdexLanguages'
import LanguageBadge from './LanguageBadge'
import Menu from './Menu'

/**
 * The dedicated language switch for the Series and Sets screens (F19): the current language as a
 * badge and its short name, opening a menu of the visible languages. Choosing one calls `onSelect`.
 */
export default function SetsLanguageSwitch({ current, languages, onSelect }) {
  const { t } = useSettings()
  const language = getTcgdexLanguage(current)
  return (
    <Menu
      label={t('sets.languageSwitch')}
      sections={[languages.map(item => ({
        id: `lang-${item.code}`,
        label: getTcgdexLanguage(item.code).name,
        checked: item.code === current,
        onSelect: () => onSelect(item.code),
      }))]}
      trigger={(
        <button
          type="button"
          data-testid="sets-language-switch"
          aria-label={`${t('sets.languageSwitch')}: ${language.name}`}
          className="glass inline-flex h-11 items-center gap-1.5 rounded-full px-3 text-text-primary ios-press"
        >
          <LanguageBadge code={current} />
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      )}
    />
  )
}
