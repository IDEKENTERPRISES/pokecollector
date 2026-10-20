import { useId } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useSettings } from '../../contexts/SettingsContext'
import { useDialogBehavior } from './dialogBehavior'
import { useBodyScrollLock, useSwipeDismiss } from '../ios/sheetGesture'

/**
 * Sheet — the legacy bottom sheet (mobile `Modal`), in the iOS page-sheet look: a grabber, glass
 * material, 16 px top corners, up to 92 dvh, and swipe down from the grabber or header to close
 * (it calls `onClose`, like the ✕, which stays).
 *
 * Props:
 *   isOpen   {boolean}  — whether the sheet is visible
 *   onClose  {fn}       — called when backdrop, X or a swipe-down is used
 *   title    {string}   — optional header title
 *   children {node}     — sheet content
 *   className {string}  — extra classes for the panel
 */
export default function Sheet({ isOpen, onClose, title, children, className = '', manageBodyScroll = true, restoreFocus = true, isObscured = false }) {
  const { t } = useSettings()
  const titleId = useId()
  const { dialogRef, onDialogKeyDown } = useDialogBehavior(isOpen, onClose, { restoreFocus })
  const { panelRef, bind } = useSwipeDismiss({ enabled: isOpen && Boolean(onClose), onDismiss: onClose })

  // Lock body scroll while sheet is open
  useBodyScrollLock(isOpen && manageBodyScroll)

  if (!isOpen) return null

  const setPanel = (node) => {
    dialogRef.current = node
    panelRef.current = node
  }

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="ios-fade-in fixed inset-0 z-50 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet panel */}
      <div
        ref={setPanel}
        className={[
          'ios-sheet-in glass fixed bottom-0 left-0 right-0 z-50',
          'rounded-t-[16px]',
          'max-h-92dvh flex flex-col outline-none',
          className,
        ].join(' ')}
        role="dialog"
        aria-modal={isObscured ? undefined : 'true'}
        aria-hidden={isObscured ? 'true' : undefined}
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : t('common.dialog')}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        {/* Grabber and header: drag down to dismiss */}
        <div {...bind} className="flex-shrink-0 select-none">
          <div className="flex justify-center pb-1 pt-2" aria-hidden="true">
            <div className="h-[5px] w-9 rounded-full bg-fill" />
          </div>

          {title && (
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <h2 id={titleId} className="text-headline text-text-primary">{title}</h2>
              <button
                onClick={onClose}
                className="grid h-9 w-9 place-items-center rounded-full bg-fill-tertiary text-text-secondary ios-press"
                aria-label={t('common.close')}
              >
                <X size={18} />
              </button>
            </div>
          )}
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto overscroll-contain pb-[var(--safe-bottom)]">
          {children}
        </div>
      </div>
    </>,
    document.body
  )
}
