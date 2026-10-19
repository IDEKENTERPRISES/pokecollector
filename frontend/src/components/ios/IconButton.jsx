import { createElement, forwardRef, isValidElement } from 'react'
import clsx from 'clsx'

const VARIANTS = {
  glass: 'glass text-text-primary',
  gray: 'bg-fill-tertiary text-text-primary',
  plain: 'bg-transparent text-tint',
}

/**
 * Round icon button with a 44 px hit area. `icon` is a lucide component or an element and
 * `label` is the accessible name (required). variant 'glass' | 'gray' | 'plain'.
 * size is the visible circle: 'md' 44 px (nav bar), 'sm' 32 px (inside a 44 px hit area).
 */
const IconButton = forwardRef(function IconButton(
  { icon, label, variant = 'glass', size = 'md', className = '', type = 'button', ...rest },
  ref,
) {
  const small = size === 'sm'
  const iconNode = isValidElement(icon) ? icon : createElement(icon, { size: small ? 18 : 20, strokeWidth: 2, 'aria-hidden': true })
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={clsx(
        'relative inline-flex flex-shrink-0 select-none items-center justify-center rounded-full',
        'ios-press focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tint',
        'disabled:opacity-40',
        small ? 'h-8 w-8' : 'h-11 w-11',
        VARIANTS[variant] ?? VARIANTS.glass,
        className,
      )}
      {...rest}
    >
      {/* Keeps a 44 px target around the 32 px circle */}
      {small && <span aria-hidden="true" className="absolute -inset-1.5" />}
      {iconNode}
    </button>
  )
})

export default IconButton
