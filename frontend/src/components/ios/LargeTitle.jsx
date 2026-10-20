import { useCallback } from 'react'
import { useNavBarStore } from '../../navigation/NavBarContext'

/**
 * The large title of a tab root (34/41 bold, left-aligned), rendered at the top of the page's
 * content. The NavBar watches it with an IntersectionObserver: once it scrolls under the bar, the
 * compact title and the scroll-edge layer fade in. `children` render under the title; without a
 * `title` the block only hosts them (Profile's trainer card takes the title's place).
 */
export default function LargeTitle({ title, subtitle, children }) {
  const store = useNavBarStore()
  const ref = useCallback(node => store?.setLargeElement(node), [store])

  return (
    <div ref={ref} data-testid="large-title" className="px-4 pb-2 pt-1">
      {title && <h1 className="text-large-title font-display">{title}</h1>}
      {subtitle && <p className="text-subheadline text-text-secondary">{subtitle}</p>}
      {children}
    </div>
  )
}
