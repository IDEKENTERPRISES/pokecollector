import clsx from 'clsx'

/**
 * Inset grouped list section: 16 px side margins, a --color-card block with radius 12, an optional
 * header and footer in Footnote, secondary, sentence case. Put ListRow children inside.
 */
export default function ListSection({ header, footer, children, className = '' }) {
  return (
    <section className={clsx('mx-4', className)}>
      {header && (
        <h3 className="px-4 pb-1.5 text-footnote text-text-secondary">{header}</h3>
      )}
      <div className="overflow-hidden rounded-xl bg-card">{children}</div>
      {footer && (
        <p className="px-4 pt-1.5 text-footnote text-text-secondary">{footer}</p>
      )}
    </section>
  )
}
