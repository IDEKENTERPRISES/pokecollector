import { useId } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { useSettings } from '../../contexts/SettingsContext'
import { useDialogBehavior } from '../ui/dialogBehavior'

/**
 * iOS alert: centred, 270 px wide, a title (Headline), a message (Footnote) and buttons side by
 * side (stacked when there are three or more). Destructive actions are red, `preferred` is bold.
 *
 * actions: [{ label, onSelect, style: 'default' | 'cancel' | 'destructive', preferred, disabled }].
 * It keeps role="dialog" (not "alertdialog") because existing specs find confirmations by that role.
 * The alert never closes itself: onSelect (or the caller) decides. Escape calls onClose; a tap on
 * the backdrop does nothing, as in iOS. `zIndex` lets ConfirmDialog sit above older overlays.
 */
export default function Alert({
  isOpen,
  onClose,
  title,
  message,
  actions = [],
  container,
  zIndex = 'var(--z-menu)',
}) {
  const { t } = useSettings()
  const titleId = useId()
  const messageId = useId()
  const { dialogRef, onDialogKeyDown } = useDialogBehavior(isOpen, onClose)
  if (!isOpen || typeof document === 'undefined') return null

  const stacked = actions.length >= 3

  return createPortal(
    <div className="fixed inset-0 flex items-center justify-center p-4" style={{ zIndex }}>
      <div className="ios-fade-in absolute inset-0 bg-black/50" aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : t('common.dialog')}
        aria-describedby={message ? messageId : undefined}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
        className="ios-alert-in glass relative w-[270px] overflow-hidden rounded-[14px] text-center outline-none"
      >
        <div className="px-4 pb-4 pt-5">
          {title && <h2 id={titleId} className="text-headline text-text-primary">{title}</h2>}
          {message && <p id={messageId} className={clsx('text-footnote text-text-primary', title && 'mt-1')}>{message}</p>}
        </div>
        <div className={clsx('border-t-[0.5px] border-border', stacked ? 'flex flex-col' : 'flex')}>
          {actions.map((action, index) => (
            <button
              key={`${action.label}-${index}`}
              type="button"
              disabled={action.disabled}
              onClick={() => action.onSelect?.()}
              className={clsx(
                'flex min-h-[44px] flex-1 items-center justify-center px-2 text-body ios-press disabled:opacity-40',
                index > 0 && (stacked ? 'border-t-[0.5px] border-border' : 'border-l-[0.5px] border-border'),
                action.style === 'destructive' ? 'text-red' : 'text-tint',
                action.preferred && 'font-semibold',
              )}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    container ?? document.body,
  )
}
