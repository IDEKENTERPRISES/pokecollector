import { Link, useLocation } from 'react-router-dom'
import { ScanLine } from 'lucide-react'
import clsx from 'clsx'
import { useAuth } from '../../contexts/AuthContext'
import { useScanner } from '../../contexts/ScannerContext'
import { useSettings } from '../../contexts/SettingsContext'
import { NAV_ICONS } from '../../navigation/navIcons'
import { PROFILE_LINKS, SIDEBAR_CHILDREN, TABS, tabForPath } from '../../navigation/navConfig'
import { readPwaFlags } from '../../pwa/flags'

function SideLink({ to, active, icon: Icon, children, indent = false }) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={clsx(
        'flex min-h-[40px] items-center gap-3 rounded-xl px-3 text-body transition-colors',
        indent && 'ml-5 min-h-[34px] text-callout',
        active ? 'bg-fill-tertiary text-text-primary' : 'text-text-secondary hover:bg-fill-quaternary hover:text-text-primary',
      )}
    >
      {Icon && <Icon size={20} strokeWidth={1.75} aria-hidden="true" className={active ? 'text-tint' : ''} />}
      <span className="truncate">{children}</span>
    </Link>
  )
}

/**
 * Desktop and iPad sidebar from 1024 px (design doc §6.13): a prominent "Scan cards" button, then
 * Home; Collection with Cards, Card Lists, Wishlist; Search with Sets, Pokédex; Profile with its
 * destinations (Log out stays a Profile row). It reads the same navConfig as the tab bar.
 */
export default function SidebarNav() {
  const { pathname } = useLocation()
  const { t } = useSettings()
  const { multiUser } = useAuth()
  const { openScanner } = useScanner()
  const activeTab = tabForPath(pathname)
  const queue = readPwaFlags().queue
  const links = PROFILE_LINKS.filter(link => (!link.multiUser || multiUser) && (!link.queue || queue))
  const exact = to => pathname === to || pathname.startsWith(`${to}/`)

  return (
    <nav
      aria-label={t('nav.sidebar')}
      data-testid="sidebar-nav"
      className="sticky top-0 hidden h-dvh w-[260px] flex-shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-bg px-3 py-4 lg:flex"
    >
      <button
        type="button"
        onClick={openScanner}
        className="btn-primary mb-3 w-full justify-center gap-2"
      >
        <ScanLine size={18} aria-hidden="true" />
        {t('nav.scanCards')}
      </button>

      {TABS.map(tab => (
        <div key={tab.key} className="space-y-0.5">
          <SideLink to={tab.root} active={activeTab === tab.key && !SIDEBAR_CHILDREN[tab.key]?.some(child => exact(child.to))} icon={NAV_ICONS[tab.key]}>
            {t(tab.labelKey)}
          </SideLink>
          {SIDEBAR_CHILDREN[tab.key]?.map(child => (
            <SideLink key={child.to} to={child.to} indent active={exact(child.to)}>{t(child.labelKey)}</SideLink>
          ))}
          {tab.key === 'profile' && links.map(link => (
            <SideLink key={link.key} to={link.to} indent active={exact(link.to)}>{t(link.labelKey)}</SideLink>
          ))}
        </div>
      ))}
    </nav>
  )
}
