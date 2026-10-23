import { isValidElement, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { useSettings } from '../../contexts/SettingsContext'
import { useDialogBehavior } from '../ui/dialogBehavior'
import ActionSheet from './ActionSheet'
import { shouldDismiss, useBodyScrollLock, useSwipeDismiss } from './sheetGesture'

export { shouldDismiss }

function HeaderButton({ spec, fallbackLabel, strong, onDefault }) {
  if (isValidElement(spec)) return spec
  const label = spec?.label ?? fallbackLabel
  if (!label) return <span />
  return (
    <button
      type="button"
      disabled={spec?.disabled}
      onClick={() => (spec?.onPress ?? onDefault)?.()}
      className={clsx(
        'min-h-[44px] px-1 text-body ios-press text-tint disabled:opacity-40',
        strong ? 'font-semibold' : '',
      )}
    >
      {label}
    </button>
  )
}

/**
 * iOS page sheet for forms and filters (design doc §6.7): a grabber, a sticky header with a
 * leading text button (default "Cancel") and an optional trailing one ("Done"), glass material,
 * 16 px top corners, up to 92 dvh, an optional sticky footer, and swipe down from the grabber or
 * header to dismiss.
 *
 * leading / trailing: a React node, or { label, onPress, disabled }. Without `leading` the sheet
 * shows Cancel, which closes it. With `isDirty`, Cancel, the swipe and the backdrop first ask
 * "Discard changes?" in an action sheet. `container` defaults to document.body (§6.1).
 */
export default function PageSheet({
  isOpen,
  onClose,
  title,
  leading,
  trailing,
  isDirty = false,
  footer,
  container,
  children,
  className = '',
}) {
  const { t } = useSettings()
  const titleId = useId()
  const [confirmingDiscard, setConfirmingDiscard] = useState(false)

  const requestClose = () => {
    if (isDirty) setConfirmingDiscard(true)
    else onClose?.()
  }

  const { dialogRef, onDialogKeyDown } = useDialogBehavior(isOpen, requestClose)
  const { panelRef, bind } = useSwipeDismiss({
    enabled: isOpen,
    onDismiss: onClose,
    // A dirty sheet springs back and asks instead of closing.
    beforeDismiss: () => {
      if (!isDirty) return true
      setConfirmingDiscard(true)
      return false
    },
  })
  useBodyScrollLock(isOpen)

  if (!isOpen || typeof document === 'undefined') return null

  const setPanel = (node) => {
    dialogRef.current = node
    panelRef.current = node
  }
  const mount = container ?? document.body

  return createPortal(
    <>
      <div
        className="ios-fade-in fixed inset-0 bg-black/50"
        style={{ zIndex: 'var(--z-sheet)' }}
        onClick={requestClose}
        aria-hidden="true"
      />
      <div
        ref={setPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : t('common.dialog')}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
        style={{ zIndex: 'var(--z-sheet)' }}
        className={clsx(
          'ios-sheet-in glass fixed inset-x-0 bottom-0 mx-auto flex w-full max-w-[640px] flex-col outline-none',
          'max-h-92dvh rounded-t-[16px]',
          className,
        )}
      >
        <div {...bind} className="cursor-grab select-none">
          <div className="flex justify-center pb-1 pt-2" aria-hidden="true">
            <div className="h-[5px] w-9 rounded-full bg-fill" />
          </div>
          <div className="grid min-h-[44px] grid-cols-[1fr_auto_1fr] items-center px-4 pb-1">
            <div className="flex justify-start">
              <HeaderButton spec={leading} fallbackLabel={t('common.cancel')} onDefault={requestClose} />
            </div>
            <h2 id={titleId} className="max-w-[60vw] break-words text-center text-headline text-text-primary">{title}</h2>
            <div className="flex justify-end">
              <HeaderButton spec={trailing} strong />
            </div>
          </div>
        </div>
        <div className="h-px flex-shrink-0 bg-border" aria-hidden="true" />
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        {footer && (
          <div className="flex-shrink-0 border-t border-border px-4 pb-[max(12px,var(--safe-bottom))] pt-3">{footer}</div>
        )}
        {!footer && <div className="flex-shrink-0" style={{ height: 'var(--safe-bottom)' }} />}
      </div>
      <ActionSheet
        isOpen={confirmingDiscard}
        onClose={() => setConfirmingDiscard(false)}
        title={t('ios.discardChangesTitle')}
        message={t('ios.discardChangesMessage')}
        cancelLabel={t('ios.keepEditing')}
        actions={[{
          label: t('ios.discard'),
          destructive: true,
          onSelect: () => { setConfirmingDiscard(false); onClose?.() },
        }]}
        container={mount}
      />
    </>,
    mount,
  )
}
