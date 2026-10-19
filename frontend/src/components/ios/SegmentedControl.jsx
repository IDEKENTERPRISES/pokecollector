import { useRef } from 'react'
import clsx from 'clsx'

/**
 * The index a key press moves to in a radio group, or null when the key does nothing.
 * Arrow keys wrap around, Home and End jump to the ends. Pure, so it is unit-tested.
 */
export function nextSegmentIndex(key, index, count) {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/**
 * iOS 26 segmented control: a capsule track, equal segments and a sliding thumb in the accent.
 * At most four segments. `role="radiogroup"` with roving tabIndex; arrows move and select.
 *
 * Props: options [{ value, label }], value, onChange(value), ariaLabel, size 'sm' (32 px) | 'md' (36 px).
 */
export default function SegmentedControl({ options, value, onChange, ariaLabel, size = 'sm', className = '' }) {
  const refs = useRef([])
  const count = options.length
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value))

  const handleKeyDown = (event) => {
    const next = nextSegmentIndex(event.key, selectedIndex, count)
    if (next === null) return
    event.preventDefault()
    onChange?.(options[next].value)
    refs.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={clsx(
        'relative flex w-full rounded-full p-0.5 bg-fill-tertiary',
        size === 'md' ? 'h-9' : 'h-8',
        className,
      )}
    >
      {count > 0 && (
        <span
          aria-hidden="true"
          className="absolute top-0.5 bottom-0.5 rounded-full bg-accent shadow-[0_2px_6px_rgba(0,0,0,0.4)] motion-safe:transition-transform motion-safe:duration-300 motion-safe:ease-ios"
          style={{
            left: 2,
            width: `calc((100% - 4px) / ${count})`,
            transform: `translateX(${selectedIndex * 100}%)`,
          }}
        />
      )}
      {options.map((option, index) => {
        const selected = index === selectedIndex
        return (
          <button
            key={option.value}
            ref={node => { refs.current[index] = node }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange?.(option.value)}
            className={clsx(
              'relative z-10 flex-1 truncate rounded-full px-2 text-footnote font-semibold ios-press',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-tint',
              selected ? 'text-on-accent' : 'text-text-primary',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
