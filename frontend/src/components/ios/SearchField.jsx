import { useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import clsx from 'clsx'
import { useSettings } from '../../contexts/SettingsContext'

/**
 * iOS search field: a rounded fill field with a magnifier, a clear button and, while focused and
 * when `onCancel` is set, a Cancel button. The input follows design doc §6.12: type="search",
 * enterKeyHint="search", no autocapitalise, autocorrect or spellcheck. The font is 16 px on touch.
 *
 * onChange receives the new string; onSubmit fires on Return; onCancel should clear and blur.
 */
export default function SearchField({
  value,
  onChange,
  onSubmit,
  placeholder,
  onCancel,
  cancelLabel,
  disabled = false,
  autoFocus = false,
  ariaLabel,
  className = '',
}) {
  const { t } = useSettings()
  const inputRef = useRef(null)
  const [focused, setFocused] = useState(false)
  const showCancel = Boolean(onCancel) && focused

  const handleCancel = () => {
    onCancel?.()
    inputRef.current?.blur()
  }

  return (
    <div role="search" className={clsx('flex items-center gap-2', className)}>
      <label
        className={clsx(
          'flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-[10px] bg-fill-tertiary px-2.5',
          'focus-within:ring-2 focus-within:ring-tint/60',
          disabled && 'opacity-50',
        )}
      >
        <Search size={16} strokeWidth={2.25} className="flex-shrink-0 text-text-muted" aria-hidden="true" />
        <input
          ref={inputRef}
          type="search"
          enterKeyHint="search"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          disabled={disabled}
          value={value}
          placeholder={placeholder}
          aria-label={ariaLabel ?? placeholder ?? t('common.search')}
          onChange={event => onChange?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            onSubmit?.(value)
            inputRef.current?.blur()
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className="min-w-0 flex-1 appearance-none bg-transparent text-callout text-text-primary outline-none placeholder:text-text-tertiary [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
        />
        {value && !disabled && (
          <button
            type="button"
            aria-label={t('ios.clearSearch')}
            // Keep focus in the field so the keyboard stays up
            onMouseDown={event => event.preventDefault()}
            onClick={() => onChange?.('')}
            className="-mr-1 grid h-8 w-8 flex-shrink-0 place-items-center text-text-muted ios-press"
          >
            <span className="grid h-4 w-4 place-items-center rounded-full bg-text-muted text-black"><X size={10} strokeWidth={3} aria-hidden="true" /></span>
          </button>
        )}
      </label>
      {showCancel && (
        <button
          type="button"
          onMouseDown={event => event.preventDefault()}
          onClick={handleCancel}
          className="flex-shrink-0 px-1 text-callout text-tint ios-press"
        >
          {cancelLabel ?? t('common.cancel')}
        </button>
      )}
    </div>
  )
}
