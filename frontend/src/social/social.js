import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'

/**
 * Swap offers, the activity feed and the weekly challenge (milestone D) show only when an admin
 * switched them on (Settings › Account) and the server runs in multi-user mode. Pure, so it is unit-tested.
 */
export function isSocialEnabled(settings, multiUser) {
  return Boolean(multiUser) && settings?.social_features_enabled === 'true'
}

// Swap offers (P11). `waiting` is the server's count of offers whose turn it is.
export const SWAPS_QUERY_KEY = ['swaps']
export const SWAPS_WAITING_QUERY_KEY = ['swaps', 'waiting']

/** The app-icon number: scans waiting for review plus swap offers waiting for you (social on only). */
export function appIconNumber(scanAttention, swapsWaiting, socialOn) {
  const scans = Math.max(0, Math.floor(Number(scanAttention) || 0))
  const swaps = socialOn ? Math.max(0, Math.floor(Number(swapsWaiting) || 0)) : 0
  return scans + swaps
}

export function useSocialEnabled() {
  const { settings } = useSettings()
  const { multiUser } = useAuth()
  return isSocialEnabled(settings, multiUser)
}
