import { ChevronLeft } from 'lucide-react'
import { useSettings } from '../../contexts/SettingsContext'
import { useBack } from '../../navigation/useBack'
import { runViewTransition } from '../../navigation/viewTransition'

/** Glass capsule "‹ Parent" (design doc §6.5); truncated to about 12 characters. Calls useBack(). */
export default function BackButton({ label }) {
  const { t } = useSettings()
  const goBack = useBack()
  const text = label || t('common.back')

  return (
    <button
      type="button"
      onClick={() => runViewTransition(goBack, { direction: 'back' })}
      data-testid="nav-back"
      aria-label={label ? `${t('common.back')}, ${label}` : t('common.back')}
      className="glass ios-press inline-flex h-11 max-w-[9.5rem] flex-shrink-0 items-center gap-0.5 rounded-full pl-2.5 pr-3.5 text-body text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tint"
    >
      <ChevronLeft size={22} strokeWidth={2.25} className="flex-shrink-0 text-tint" aria-hidden="true" />
      <span className="truncate">{text}</span>
    </button>
  )
}
