import { useEffect, useId, useRef, useState } from 'react'

import { useSettings } from '../contexts/SettingsContext'
import { acquiredDateInputValue, formatAcquiredDate, todayInputValue } from '../utils/acquiredDate'

// Owner-editable "Acquired" date for one owned copy. `value` is the item's
// acquired_at (which the API defaults to the date it was added); `onCommit`
// receives a YYYY-MM-DD string whenever the user picks a different day.
export default function AcquiredDateField({ value, onCommit, disabled = false, compact = false }) {
  const { t, language } = useSettings()
  const inputId = useId()
  const current = acquiredDateInputValue(value)
  const [draft, setDraft] = useState(current)
  // change and blur both fire for one pick; only the first should save.
  const lastCommitted = useRef(current)

  useEffect(() => {
    setDraft(current)
    lastCommitted.current = current
  }, [current])

  const commit = next => {
    if (!next) {
      setDraft(current)
      return
    }
    if (next === lastCommitted.current) return
    lastCommitted.current = next
    onCommit(next)
  }

  return (
    <div className={compact ? 'flex flex-wrap items-center gap-x-2 gap-y-1' : 'space-y-1'}>
      <label htmlFor={inputId} className="text-[11px] font-medium text-text-muted">
        {t('collection.acquired')}
      </label>
      <input
        id={inputId}
        type="date"
        value={draft}
        max={todayInputValue()}
        disabled={disabled}
        onChange={event => {
          setDraft(event.target.value)
          // Native pickers fire change with the finished date; typing fires it per keystroke.
          if (event.target.value.length === 10) commit(event.target.value)
        }}
        onBlur={() => commit(draft)}
        className="input px-2 py-1 text-xs"
        style={{ colorScheme: 'dark', width: compact ? '9.5rem' : undefined }}
        aria-label={`${t('collection.acquired')}${current ? `: ${formatAcquiredDate(current, language)}` : ''}`}
      />
    </div>
  )
}
