import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'

/**
 * Swap offers, the activity feed and the weekly challenge (milestone D) show only when an admin
 * switched them on (Settings › Account) and the server runs in multi-user mode. Pure, so it is unit-tested.
 */
export function isSocialEnabled(settings, multiUser) {
  return Boolean(multiUser) && settings?.social_features_enabled === 'true'
}

export function useSocialEnabled() {
  const { settings } = useSettings()
  const { multiUser } = useAuth()
  return isSocialEnabled(settings, multiUser)
}
