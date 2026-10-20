import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useSettings } from '../../contexts/SettingsContext'
import { getHistory, previousEntry } from '../../navigation/historyMirror'
import {
  backLabelKeyForPath,
  goesBackToPrevious,
  isOwnBack,
  isRootPath,
  labelKeyForPath,
  titleKeyForPath,
} from '../../navigation/navConfig'
import {
  useLargeTitleElement,
  useNavBarOptions,
  useNavBarStore,
} from '../../navigation/NavBarContext'
import SyncIndicator from '../sync/SyncIndicator'
import BackButton from './BackButton'
import StatusLine from './StatusLine'

/**
 * The shell's nav bar (design doc §6.5), rendered once by Layout. A plain <div>: not a <header>
 * (DeckEditor's tests look for the only header) and not a second <nav> landmark.
 *
 * Interim mode: a page that never calls useNavBar gets a compact bar with the navConfig title and a
 * back button unless the route has "own back". A tab root that renders <LargeTitle> shows the
 * compact title only after the large one has scrolled under the bar.
 */
export default function NavBar() {
  const store = useNavBarStore()
  const options = useNavBarOptions(store)
  const largeElement = useLargeTitleElement(store)
  const { pathname } = useLocation()
  const { t } = useSettings()
  const barRef = useRef(null)
  const sentinelRef = useRef(null)
  const [largeVisible, setLargeVisible] = useState(true)
  const [scrolled, setScrolled] = useState(false)

  // Content scrolled under the bar: a sentinel at the very top of the page leaves the viewport.
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting), { threshold: 0 })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [])

  // The large title sliding under the bar toggles the compact title.
  useEffect(() => {
    if (!largeElement || typeof IntersectionObserver === 'undefined') {
      setLargeVisible(true)
      return undefined
    }
    const offset = barRef.current?.offsetHeight ?? 44
    const observer = new IntersectionObserver(
      ([entry]) => setLargeVisible(entry.isIntersecting),
      { rootMargin: `-${offset}px 0px 0px 0px`, threshold: 0 },
    )
    observer.observe(largeElement)
    return () => observer.disconnect()
  }, [largeElement, pathname])

  const pushed = !isRootPath(pathname)
  const showBack = pushed && !options?.hideBack && (Boolean(options) || !isOwnBack(pathname))

  let backLabel = options?.backLabel
  if (!backLabel && showBack) {
    const key = goesBackToPrevious(pathname)
      ? labelKeyForPath(previousEntry(getHistory())?.path?.split('?')[0]) ?? 'nav.home'
      : backLabelKeyForPath(pathname)
    backLabel = key ? t(key) : undefined
  }

  const titleKey = titleKeyForPath(pathname)
  const title = options?.title ?? (titleKey ? t(titleKey) : '')
  const largeTitleShowing = Boolean(largeElement) && largeVisible
  const edge = scrolled || (Boolean(largeElement) && !largeVisible)

  return (
    <>
      <div ref={sentinelRef} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-px w-px" />
      <div
        data-testid="nav-bar"
        data-scrolled={edge ? 'true' : 'false'}
        className="sticky top-0 z-navbar"
        style={{ paddingTop: 'var(--safe-top)' }}
      >
        {/* Scroll edge: black at the top (meeting the opaque status bar), fading out, with a light masked blur. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 -bottom-4 top-0 transition-opacity duration-150 motion-reduce:transition-none"
          style={{
            opacity: edge ? 1 : 0,
            background: 'linear-gradient(to bottom, #000 0%, #000 60%, rgba(0,0,0,0) 100%)',
            WebkitBackdropFilter: 'blur(6px)',
            backdropFilter: 'blur(6px)',
            WebkitMaskImage: 'linear-gradient(to bottom, #000 70%, transparent 100%)',
            maskImage: 'linear-gradient(to bottom, #000 70%, transparent 100%)',
          }}
        />
        <div
          ref={barRef}
          className="relative grid items-center gap-2 px-4"
          style={{ minHeight: 'var(--navbar-height)', gridTemplateColumns: '1fr auto 1fr' }}
        >
          <div className="flex min-w-0 justify-start">
            {showBack && <BackButton label={backLabel} />}
          </div>
          <p
            data-testid="nav-title"
            aria-hidden={largeTitleShowing ? 'true' : undefined}
            className="max-w-[52vw] truncate text-center text-headline font-semibold transition-opacity duration-150 motion-reduce:transition-none lg:max-w-[40vw]"
            style={{ opacity: largeTitleShowing ? 0 : 1 }}
          >
            {title}
          </p>
          <div className="flex min-w-0 items-center justify-end gap-2">
            <SyncIndicator />
            {options?.trailing}
          </div>
        </div>
        <StatusLine />
      </div>
    </>
  )
}
