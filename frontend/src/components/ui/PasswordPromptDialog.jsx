import { useEffect, useState } from 'react'
import { Loader2, Lock } from 'lucide-react'
import Modal from './Modal'

// Asks the signed-in user to re-enter their password before a destructive action.
// The caller receives the password in onSubmit and sends it to the server, which
// does the actual verification.
export default function PasswordPromptDialog({
  isOpen,
  onClose,
  onSubmit,
  title,
  message,
  label,
  submitLabel,
  cancelLabel,
  isPending = false,
}) {
  const [password, setPassword] = useState('')

  useEffect(() => {
    if (!isOpen) setPassword('')
  }, [isOpen])

  const submit = event => {
    event.preventDefault()
    if (password && !isPending) onSubmit(password)
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={isPending ? undefined : onClose}
      title={title}
      size="sm"
      mobileSheet={false}
      overlayClassName="z-[500]"
    >
      <form onSubmit={submit} className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 flex-shrink-0 place-items-center rounded-full bg-brand-red/10 text-brand-red">
            <Lock size={18} aria-hidden />
          </span>
          <p className="text-sm leading-relaxed text-text-secondary">{message}</p>
        </div>
        <div>
          <label className="mb-1 block text-xs text-text-muted" htmlFor="password-prompt-input">{label}</label>
          <input
            id="password-prompt-input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={event => setPassword(event.target.value)}
            disabled={isPending}
            className="input w-full"
          />
        </div>
        <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
          <button type="button" className="btn-ghost w-full justify-center sm:w-auto" disabled={isPending} onClick={onClose}>
            {cancelLabel}
          </button>
          <button
            type="submit"
            className="btn-ghost w-full justify-center border-brand-red/30 text-brand-red hover:bg-brand-red/10 sm:w-auto"
            disabled={isPending || !password}
          >
            {isPending && <Loader2 size={15} className="animate-spin" aria-hidden />}
            {submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}
