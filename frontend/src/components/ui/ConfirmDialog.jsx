import { Loader2 } from 'lucide-react'
import Alert from '../ios/Alert'

/**
 * Confirmation prompt. The props are unchanged; it renders an iOS Alert, so every
 * useConfirmDialog() call is an iOS alert (design doc §6.8). Sits above the older overlays (z 500).
 */
export default function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel,
  cancelLabel,
  isPending = false,
  destructive = false,
}) {
  return (
    <Alert
      isOpen={isOpen}
      onClose={isPending ? undefined : onClose}
      title={title}
      message={message}
      zIndex={500}
      actions={[
        { label: cancelLabel, style: 'cancel', disabled: isPending, onSelect: onClose },
        {
          label: (
            <span className="inline-flex items-center gap-1.5">
              {isPending && <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden />}
              {confirmLabel}
            </span>
          ),
          style: destructive ? 'destructive' : 'default',
          preferred: true,
          disabled: isPending,
          onSelect: onConfirm,
        },
      ]}
    />
  )
}
