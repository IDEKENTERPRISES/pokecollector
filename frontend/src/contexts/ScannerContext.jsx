import { Suspense, createContext, lazy, useCallback, useContext, useMemo, useState } from 'react'

// The scan overlay (design doc §5.3). Layout provides it and renders the scanner outside the routed
// <Outlet>, so OfflineUnavailable never hides it and offline scanning works from every tab.
// Camera-first scanning arrives with P4; until then this opens the existing UnifiedCardScanner.

const UnifiedCardScanner = lazy(() => import('../components/UnifiedCardScanner'))

const ScannerContext = createContext({
  isOpen: false,
  openScanner: () => {},
  closeScanner: () => {},
})

export function ScannerProvider({ children }) {
  const [isOpen, setIsOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const openScanner = useCallback(() => {
    setMounted(true)
    setIsOpen(true)
  }, [])
  const closeScanner = useCallback(() => setIsOpen(false), [])
  const value = useMemo(() => ({ isOpen, openScanner, closeScanner }), [isOpen, openScanner, closeScanner])

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
