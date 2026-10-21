import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { User } from 'lucide-react'
import clsx from 'clsx'
import { getScanJobs } from '../../api/client'
import { useAuth } from '../../contexts/AuthContext'
import { useScanner } from '../../contexts/ScannerContext'
import { useSettings } from '../../contexts/SettingsContext'
import { NAV_ICONS } from '../../navigation/navIcons'
import { TABS, sectionForPath, tabForPath } from '../../navigation/navConfig'
import {
  getTabMemory,
  locationId,
  requestScrollRestore,
  resolveTabPress,
  saveScroll,
} from '../../navigation/tabMemory'
import { useKeyboardOpen } from '../../navigation/useKeyboardOpen'
import { SCAN_JOBS_QUERY_KEY, hasActiveScanJobs, scanAttentionCount } from '../../utils/scanJobs'
import ScanButton from './ScanButton'

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/** Run what a tap on a tab means (design doc §6.3): switch, return to the root, or scroll to the top. */
export function pressTab({ tabKey, location, navigate }) {
  const action = resolveTabPress(getTabMemory(), tabKey, location.pathname)
  if (action.type === 'scrollTop') {
    window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' })
  } else if (action.type === 'navigate') {
    saveScroll(locationId(location))
    requestScrollRestore(action.to)
    navigate(action.to)
  }
}

function TrainerSprite({ avatarId }) {
  const [failed, setFailed] = useState(false)
  if (!avatarId || failed) return <User size={24} strokeWidth={1.75} aria-hidden="true" />
  return (
    <img
      src={`/api/pokedex/images/sprites/${avatarId}.png`}
      alt=""
      width={26}
      height={26}
      className="h-[26px] w-[26px] rounded-full object-contain"
      onError={() => setFailed(true)}
    />
  )
}

// The Profile page is a lazy route chunk; fetch it before the first tap (idle, or as the finger lands).
const preloadProfile = () => import('../../pages/Profile').catch(() => {})

function Tab({ tab, active, onPress, avatarId, label }) {
  const Icon = NAV_ICONS[tab.key]
  return (
    <a
      href={tab.root}
      aria-current={active ? 'page' : undefined}
      data-testid={`tab-${tab.key}`}
      onPointerDown={tab.key === 'profile' ? preloadProfile : undefined}
      onPointerEnter={tab.key === 'profile' ? preloadProfile : undefined}
      onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return
        event.preventDefault()
        onPress(tab.key)
      }}
      className={clsx(
        'ios-press no-callout relative mx-auto flex h-[52px] w-full min-w-[44px] max-w-[76px] flex-col items-center justify-center gap-0.5 rounded-full',
        'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-tint',
        active ? 'text-tint' : 'text-text-secondary',
      )}
      style={active ? { background: 'color-mix(in srgb, var(--color-accent) 18%, transparent)' } : undefined}
    >
      {tab.key === 'profile'
        ? <TrainerSprite avatarId={avatarId} />
        : <Icon size={24} strokeWidth={1.75} aria-hidden="true" />}
      <span className="font-display text-caption-2 font-medium">{label}</span>
    </a>
  )
}

/**
 * The floating glass tab bar (design doc §6.2): Home · Collection · (Scan) · Search · Profile.
 * Portaled to document.body as its own fixed element, because `#root > *` forces `position: relative`
 * on direct children of #root. Hidden at 1024 px and wider (the sidebar replaces it), while the
 * scanner is open and while the keyboard is up.
 */
export default function TabBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { t } = useSettings()
  const { user } = useAuth()
  const { isOpen: scannerOpen, openScanner } = useScanner()
  const keyboardOpen = useKeyboardOpen()

  useEffect(() => {
    const idle = window.requestIdleCallback ?? (cb => window.setTimeout(cb, 1500))
    const cancel = window.cancelIdleCallback ?? window.clearTimeout
    const handle = idle(preloadProfile)
    return () => cancel(handle)
  }, [])

  const { data: scanData } = useQuery({
    queryKey: SCAN_JOBS_QUERY_KEY,
    queryFn: getScanJobs,
    staleTime: 15000,
    retry: 1,
    refetchInterval: query => hasActiveScanJobs(query.state.data?.jobs || []) ? 3000 : false,
  })
  const jobs = scanData?.jobs || []
  const attention = scanAttentionCount(jobs)
  const processing = hasActiveScanJobs(jobs)

  if (scannerOpen || keyboardOpen) return null

  const activeTab = tabForPath(location.pathname)
  const scanActive = sectionForPath(location.pathname) === 'scan'
  const press = tabKey => pressTab({ tabKey, location, navigate })
  const [home, collection, search, profile] = TABS
  const tabProps = tab => ({
    tab,
    active: activeTab === tab.key,
    onPress: press,
    avatarId: user?.avatar_id,
    label: t(tab.labelKey),
  })

  return createPortal(
    <nav
      aria-label={t('nav.tabBar')}
      data-testid="tab-bar"
      className="vt-tabbar pointer-events-none fixed inset-x-0 z-tabbar flex justify-center px-3 lg:hidden"
      style={{ bottom: 'max(8px, calc(var(--safe-bottom) - 10px))' }}
    >
      <div
        className="glass pointer-events-auto relative grid w-full max-w-[440px] grid-cols-5 items-center rounded-full px-1"
        style={{ height: 'var(--tabbar-height)' }}
      >
        <Tab {...tabProps(home)} />
        <Tab {...tabProps(collection)} />
        <ScanButton badge={attention} processing={processing} active={scanActive} onPress={openScanner} />
        <Tab {...tabProps(search)} />
        <Tab {...tabProps(profile)} />
      </div>
    </nav>,
    document.body,
  )
}
