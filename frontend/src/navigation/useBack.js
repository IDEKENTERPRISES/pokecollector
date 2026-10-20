import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { getHistory, previousEntry } from './historyMirror.js'
import { goesBackToPrevious, parentForPath, sectionForPath, sectionRoot } from './navConfig.js'

/**
 * Where "back" goes from `pathname` (design doc §6.4), as `{ type: 'back' }` for `navigate(-1)` or
 * `{ type: 'replace', to }`:
 *  - the previous mirror entry is in the same section, or the route goes back to the previous
 *    screen (`/scans`): navigate(-1), so list scroll restoration still works (it is a POP);
 *  - otherwise (deep link, cold start, a tab switch in between) the route's parent, else the
 *    section root, with `replace`.
 */
export function decideBack(history, pathname) {
  const previous = previousEntry(history)
  const section = sectionForPath(pathname)
  if (goesBackToPrevious(pathname)) {
    return previous ? { type: 'back' } : { type: 'replace', to: '/' }
  }
  if (previous && section && previous.section === section) return { type: 'back' }
  return { type: 'replace', to: parentForPath(pathname) ?? sectionRoot(section) }
}

/** `() => void`: go back one logical screen. Never relies on browser chrome or an edge swipe. */
export function useBack() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  return useCallback(() => {
    const decision = decideBack(getHistory(), pathname)
    if (decision.type === 'back') navigate(-1)
    else navigate(decision.to, { replace: true })
  }, [navigate, pathname])
}
