import { useId } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { useSettings } from '../../contexts/SettingsContext'
import { useDialogBehavior } from '../ui/dialogBehavior'

/**
 * iOS action sheet: one glass group of 56 px rows (optional title and message in Footnote) and a
 * separate bold Cancel, rising from the bottom. For destructive or multi-way choices.
 *
 * actions: [{ label, onSelect, destructive }]. A chosen action runs onSelect and then onClose.
 * Backdrop, Escape and Cancel call onClose. `container` defaults to document.body (§6.1).
 */
export default function ActionSheet({
  isOpen,
  onClose,
  title,
  message,
  actions = [],
  cancelLabel,
  container,
  zIndex = 'var(--z-menu)',
}) {
  const { t } = useSettings()
  const titleId = useId()
  const { dialogRef, onDialogKeyDown } = useDialogBehavior(isOpen, onClose)
  if (!isOpen || typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed inset-0 flex items-end justify-center" style={{ zIndex }}>
      <div className="ios-fade-in absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : t('common.dialog')}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
        className="ios-sheet-in relative w-full max-w-[440px] space-y-2 px-2 pb-[max(8px,var(--safe-bottom))] outline-none"
      >
        <div className="glass overflow-hidden rounded-[14px]">
          {(title || message) && (
            <div className="px-4 py-3 text-center">
              {title && <h2 id={titleId} className="text-footnote font-semibold text-text-secondary">{title}</h2>}
              {message && <p className="text-footnote text-text-secondary">{message}</p>}
            </div>
          )}
          {actions.map((action, index) => (
            <button
              key={`${action.label}-${index}`}
              type="button"
              disabled={action.disabled}
              onClick={() => {
                action.onSelect?.()
                onClose?.()
              }}
              className={clsx(
                'flex min-h-[56px] w-full items-center justify-center border-t-[0.5px] border-border px-4 text-body ios-press',
                'disabled:opacity-40',
                action.destructive ? 'text-red' : 'text-tint',
              )}
            >
              {action.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="glass flex min-h-[56px] w-full items-center justify-center rounded-[14px] text-body font-semibold text-tint ios-press"
        >
          {cancelLabel ?? t('common.cancel')}
        </button>
      </div>
    </div>,
    container ?? document.body,
  )
}
