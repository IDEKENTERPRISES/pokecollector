import { Suspense, createContext, lazy, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'

// The scan overlay (design doc §5.3). Layout provides it and renders the scanner outside the routed
// <Outlet>, so OfflineUnavailable never hides it and offline scanning works from every tab.
// Camera-first scanning arrives with P4; until then this opens the existing UnifiedCardScanner.

const loadScanner = () => import('../components/UnifiedCardScanner')
const UnifiedCardScanner = lazy(loadScanner)

const ScannerContext = createContext({
  isOpen: false,
  openScanner: () => {},
  closeScanner: () => {},
})

/**
 * Whether the scanner really covers the app. It only does once its chunk has loaded: while the chunk is
 * still loading (or failed to load, offline) the Suspense fallback draws nothing, and treating that as
 * "open" hid the tab bar behind an empty screen.
 */
export function scannerCoversApp({ isOpen, ready }) {
  return Boolean(isOpen && ready)
}

export function ScannerProvider({ children }) {
  const { pathname } = useLocation()
  const [isOpen, setIsOpen] = useState(false)
  const [ready, setReady] = useState(false)
  const [mounted, setMounted] = useState(false)
  const openRef = useRef(false)
  const openScanner = useCallback(() => {
    openRef.current = true
    setMounted(true)
    setIsOpen(true)
    loadScanner().then(
      () => { if (openRef.current) setReady(true) },
      () => {
        // The chunk never arrived: do not leave a hidden tab bar over an empty screen.
        openRef.current = false
        setIsOpen(false)
        setReady(false)
      },
    )
  }, [])
  const closeScanner = useCallback(() => {
    openRef.current = false
    setIsOpen(false)
    setReady(false)
  }, [])

  // The scanner sits outside the routes, so a back swipe or a link would leave it open over the new
  // page. Its own navigations (to /scans) close it first, so closing on every path change is safe.
  const lastPath = useRef(pathname)
  useEffect(() => {
    if (lastPath.current === pathname) return
    lastPath.current = pathname
    if (openRef.current) closeScanner()
  }, [pathname, closeScanner])

  const covers = scannerCoversApp({ isOpen, ready })
  const value = useMemo(() => ({ isOpen: covers, openScanner, closeScanner }), [covers, openScanner, closeScanner])

  return (
    <ScannerContext.Provider value={value}>
      {children}
      {mounted && (
        <Suspense fallback={null}>
          <UnifiedCardScanner isOpen={isOpen} onClose={closeScanner} />
        </Suspense>
      )}
    </ScannerContext.Provider>
  )
}

/** `{ isOpen, openScanner, closeScanner }` */
export function useScanner() {
  return useContext(ScannerContext)
}
