import { Eye, EyeOff } from 'lucide-react'
import { useSettings } from '../../contexts/SettingsContext'
import { useHideValues } from './hideValues'
import IconButton from './IconButton'

/**
 * Eye button that hides every amount in the app (Q1a, Q16). One constant label with `aria-pressed`
 * (the standard toggle pattern: VoiceOver reads "Hide values, toggle button, on"); only the icon changes.
 */
export default function HideValuesToggle({ variant = 'glass', size = 'md' }) {
  const { t } = useSettings()
  const { hidden, toggle } = useHideValues()
  return (
    <IconButton
      icon={hidden ? EyeOff : Eye}
      label={t('ios.hideValues')}
      variant={variant}
      size={size}
      aria-pressed={hidden}
      onClick={toggle}
    />
  )
}
