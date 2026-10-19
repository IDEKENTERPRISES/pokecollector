import { createElement, forwardRef, isValidElement } from 'react'
import { Loader2 } from 'lucide-react'
import clsx from 'clsx'

const SIZES = {
  sm: 'min-h-[32px] px-3.5 text-subheadline',
  md: 'min-h-[44px] px-5 text-callout',
  lg: 'min-h-[50px] px-6 text-headline',
}

function variantClasses(variant, destructive) {
  if (variant === 'tinted') {
    return destructive
      ? 'bg-red/15 text-red'
      : 'bg-accent/20 text-tint'
  }
  if (variant === 'gray') return destructive ? 'bg-fill-tertiary text-red' : 'bg-fill-tertiary text-text-primary'
  if (variant === 'plain') return destructive ? 'bg-transparent text-red' : 'bg-transparent text-tint'
  // filled
  return destructive ? 'bg-red text-white' : 'bg-accent text-on-accent shadow-[0_4px_14px_color-mix(in_srgb,var(--color-accent)_28%,transparent)]'
}

/**
 * Capsule button. variant 'filled' | 'tinted' | 'gray' | 'plain'; size 'sm' | 'md' | 'lg';
 * `destructive` swaps to the semantic red; `icon` is a lucide component or element; `loading`
 * shows a spinner and disables it; `full` makes it fill the width.
 */
const Button = forwardRef(function Button({
  variant = 'filled',
  size = 'md',
  destructive = false,
  icon,
  loading = false,
  full = false,
  disabled = false,
  type = 'button',
  className = '',
  children,
  ...rest
}, ref) {
  const iconNode = icon
    ? (isValidElement(icon) ? icon : createElement(icon, { size: size === 'sm' ? 15 : 18, 'aria-hidden': true }))
    : null
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={clsx(
        'inline-flex select-none items-center justify-center gap-2 rounded-full font-semibold',
        'ios-press focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tint',
        'disabled:cursor-not-allowed disabled:opacity-40',
        SIZES[size] ?? SIZES.md,
        variantClasses(variant, destructive),
        full && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={size === 'sm' ? 15 : 18} className="motion-safe:animate-spin" aria-hidden="true" /> : iconNode}
      {children}
    </button>
  )
})

export default Button
