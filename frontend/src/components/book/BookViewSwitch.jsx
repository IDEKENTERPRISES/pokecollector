import { BookOpen, Grid2X2 } from 'lucide-react'
import clsx from 'clsx'
import { useSettings } from '../../contexts/SettingsContext'

/** The Grid | Book switch, styled like Collection's Grid | List switch. */
export default function BookViewSwitch({ value, onChange }) {
  const { t } = useSettings()
  const options = [
    { key: 'grid', label: t('book.gridView'), Icon: Grid2X2 },
    { key: 'book', label: t('book.bookView'), Icon: BookOpen },
  ]
  return (
    <div className="flex items-center gap-0.5 rounded-full bg-fill-tertiary p-0.5" role="group" aria-label={t('book.viewMode')}>
      {options.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          title={label}
          aria-label={label}
          aria-pressed={value === key}
          className={clsx('ios-press grid h-8 w-8 place-items-center rounded-full', value === key ? 'bg-accent text-on-accent' : 'text-text-secondary')}
        >
          <Icon size={15} aria-hidden="true" />
        </button>
      ))}
    </div>
  )
}
