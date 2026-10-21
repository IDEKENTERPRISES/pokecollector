import { createElement, isValidElement } from 'react'
import Link from './TransitionLink'
import { ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import Badge from './Badge'

function renderIcon(icon, size) {
  if (!icon) return null
  return isValidElement(icon) ? icon : createElement(icon, { size, strokeWidth: 1.9, 'aria-hidden': true })
}

/**
 * One row of a ListSection. Renders a router Link (`to`), an `a` (`href`), a button (`onClick`)
 * or a plain div, at least 44 px tall. Drilling rows show a chevron; `trailing` replaces it (switches).
 *
 * Props: icon (lucide component or element) + iconColor (the 29 px square's colour), leading,
 * title, subtitle, value, badge (count), to, href, onClick, chevron, trailing, destructive,
 * disabled, testId.
 */
export default function ListRow({
  icon,
  iconColor = 'var(--color-fill)',
  leading,
  title,
  subtitle,
  value,
  badge,
  to,
  href,
  onClick,
  chevron,
  trailing,
  destructive = false,
  disabled = false,
  testId,
  className = '',
  ...rest
}) {
  const interactive = Boolean(to || href || onClick) && !disabled
  const showChevron = trailing === undefined && (chevron ?? Boolean(to || href))
  const hasLeading = Boolean(icon || leading)

  const classes = clsx(
    'relative flex min-h-[44px] w-full items-center gap-3 px-4 py-[11px] text-left',
    // The separator is inset to the text (past the icon square when there is one).
    'after:pointer-events-none after:absolute after:bottom-0 after:right-0 after:h-[0.5px] after:bg-border last:after:hidden',
    hasLeading && icon ? 'after:left-[60px]' : 'after:left-4',
    interactive && 'active:bg-elevated',
    disabled && 'opacity-40',
    destructive ? 'text-red' : 'text-text-primary',
    className,
  )

  const body = (
    <>
      {icon && (
        <span
          className="grid h-[29px] w-[29px] flex-shrink-0 place-items-center rounded-[7px] text-white"
          style={{ background: iconColor }}
        >
          {renderIcon(icon, 18)}
        </span>
      )}
      {leading}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body">{title}</span>
        {subtitle && <span className="block text-footnote text-text-secondary">{subtitle}</span>}
      </span>
      {badge ? <Badge count={badge} tone="red" /> : null}
      {value != null && <span className="max-w-[45%] flex-shrink-0 truncate text-body text-text-secondary tabular-nums">{value}</span>}
      {trailing}
      {showChevron && <ChevronRight size={18} strokeWidth={2.25} className="flex-shrink-0 text-text-tertiary" aria-hidden="true" />}
    </>
  )

  const common = { className: classes, 'data-testid': testId, ...rest }

  if (to && !disabled) return <Link to={to} {...common}>{body}</Link>
  if (href && !disabled) return <a href={href} {...common}>{body}</a>
  if (onClick) {
    return <button type="button" onClick={onClick} disabled={disabled} {...common}>{body}</button>
  }
  return <div {...common}>{body}</div>
}
