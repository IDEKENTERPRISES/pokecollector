import { useId } from 'react'
import { createPortal } from 'react-dom'

/**
 * The welcome, Home Screen and end cards (docs/WELCOME_DESIGN.md §4.3): a centred glass card over the dimmed app.
 * `children` is a function that receives the title id, so the card can label itself.
 */
export default function CenterCard({ children, label }) {
  const titleId = useId()
  return createPortal(
    <div data-tour-layer data-testid="tour-center" className="fixed inset-0 flex items-center justify-center px-4" style={{ zIndex: 'var(--z-tour)' }}>
      <div className="absolute inset-0 bg-black/[0.72]" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-label={label}
        tabIndex={-1}
        className="glass relative max-h-[calc(100dvh-32px)] w-full max-w-[440px] overflow-y-auto rounded-[16px] px-5 pb-5 pt-6 outline-none"
        style={{ background: 'var(--color-card)' }}
      >
        {typeof children === 'function' ? children(titleId) : children}
      </div>
    </div>,
    document.body,
  )
}
