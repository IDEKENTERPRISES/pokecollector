import clsx from 'clsx'
import { getTcgdexLanguage, tcgdexLanguageBadgeClass } from '../../utils/tcgdexLanguages'

/** The language pill used across the app: flag-free short code in the language's colour. */
export default function LanguageBadge({ code, className = '' }) {
  const language = getTcgdexLanguage(code)
  return (
    <span
      data-testid="language-badge"
      className={clsx('inline-flex min-w-[2.25rem] items-center justify-center rounded-md px-1.5 py-0.5 text-caption-1 font-semibold leading-none', tcgdexLanguageBadgeClass(code), className)}
    >
      {language.short}
    </span>
  )
}
