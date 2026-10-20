import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigationType } from 'react-router-dom'
import clsx from 'clsx'
import OfflineUnavailable from './OfflineUnavailable'
import NavBar from './ios/NavBar'
import SidebarNav from './ios/SidebarNav'
import TabBar from './ios/TabBar'
import { ScannerProvider } from '../contexts/ScannerContext'
import { useReleaseManualHistoryScrollRestoration } from '../hooks/useListScrollRestoration'
import { recordNavigation } from '../navigation/historyMirror'
import { NavBarContext, createNavBarStore } from '../navigation/NavBarContext'
import { locationId, restorePendingScroll, visitLocation } from '../navigation/tabMemory'
import { isOfflineRoute } from '../offline/routes'
import { useOffline } from '../offline/useOffline'

/**
 * The app shell (design doc §6.1): one NavBar, the desktop SidebarNav, one <main> and, portaled to
 * <body>, the TabBar. The document stays the scroller (no overflow wrapper), so a status-bar tap
 * scrolls to the top.
 */
export default function Layout() {
  const location = useLocation()
  const navigationType = useNavigationType()
  const isHome = location.pathname === '/'
  const offline = useOffline()
  const showUnavailable = offline && !isOfflineRoute(location.pathname)
  const [navBarStore] = useState(createNavBarStore)
  useReleaseManualHistoryScrollRestoration()

  // The history mirror (§6.4) must know the current entry when the nav bar renders its back label,
  // so it is recorded during render, once per location key.
  const recordedKey = useRef(null)
  if (recordedKey.current !== location.key) {
    recordedKey.current = location.key
    recordNavigation({
      type: navigationType,
      key: location.key,
      path: `${location.pathname}${location.search}`,
    })
  }

  useEffect(() => {
    visitLocation(location)
  }, [location.pathname, location.search]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => restorePendingScroll(locationId(location)), [location.key]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <NavBarContext.Provider value={navBarStore}>
      <ScannerProvider>
        <div className="relative min-h-dvh bg-bg lg:flex">
          <SidebarNav />
          <div className="relative min-w-0 flex-1">
            <div className="mx-auto flex min-h-dvh w-full max-w-[1200px] flex-col">
              <NavBar />
              <main
                className={clsx(
                  'flex-1 pb-[var(--content-bottom)] lg:pb-8',
                  !isHome && 'w-full px-4 sm:px-8 lg:px-8',
                )}
              >
                {showUnavailable ? <OfflineUnavailable /> : <Outlet />}
              </main>
            </div>
          </div>
        </div>
        <TabBar />
      </ScannerProvider>
    </NavBarContext.Provider>
  )
}
