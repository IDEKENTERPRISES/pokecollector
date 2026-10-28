// The number on the Home Screen icon (engagement P4): scans waiting for review. Only things to act
// on are counted, never informational notifications. A no-op where the Badging API is missing.
export function setAppBadge(count, nav = typeof navigator === 'undefined' ? undefined : navigator) {
  const n = Number.isInteger(count) && count > 0 ? count : 0
  try {
    if (!nav) return Promise.resolve(false)
    if (n > 0 && typeof nav.setAppBadge === 'function') return Promise.resolve(nav.setAppBadge(n)).then(() => true, () => false)
    if (n === 0 && typeof nav.clearAppBadge === 'function') return Promise.resolve(nav.clearAppBadge()).then(() => true, () => false)
  } catch {
    // Not supported or no notification permission: the badge is a nicety.
  }
  return Promise.resolve(false)
}
