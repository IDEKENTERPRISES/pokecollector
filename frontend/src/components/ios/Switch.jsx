import clsx from 'clsx'

/** iOS switch, 51×31, green when on. `label` is the accessible name. */
export default function Switch({ checked, onChange, label, disabled = false, className = '' }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={Boolean(checked)}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={clsx(
        'relative inline-flex h-[31px] w-[51px] flex-shrink-0 items-center rounded-full p-0.5',
        'motion-safe:transition-colors motion-safe:duration-200',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tint',
        checked ? 'bg-green' : 'bg-fill-secondary',
        disabled && 'opacity-40',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'h-[27px] w-[27px] rounded-full bg-white shadow-[0_2px_4px_rgba(0,0,0,0.35)]',
          'motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-ios',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  )
}
