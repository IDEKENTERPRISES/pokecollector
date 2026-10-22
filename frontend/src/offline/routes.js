// Which pages open while the server is unreachable (owner feedback F12: "make sure that all pages are
// cacheable"). Every page of the shell does: one that was opened before shows its saved copy, one that
// never was shows its normal empty state plus a short note (see offline/notSaved.js). The exceptions
// list is for a page that cannot work at all without the server; it is empty, and each entry would need
// a reason here.

import { matchPattern, matchRoute } from '../navigation/navConfig.js'

export const OFFLINE_EXCEPTIONS = Object.freeze([])

/** True for every page of the shell (not for unknown paths, redirects or pages outside the shell) unless excepted. */
export function isOfflineRoute(pathname) {
  if (!pathname) return false
  const match = matchRoute(String(pathname))
  if (match?.kind !== 'route') return false
  return !OFFLINE_EXCEPTIONS.some(pattern => matchPattern(pattern, pathname))
}
