import { forwardRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { isInstantPath, isPushedPath } from '../../navigation/navConfig'
import { isRouteReady, pathnameOf, preloadRoute, whenRouteReady } from '../../navigation/routePreload'
import { isPlainClick, runViewTransition, viewTransitionsEnabled } from '../../navigation/viewTransition'

/**
 * A router Link that slides the next page in (design doc §14 P8, Q1c) when it opens a pushed page
 * (a detail, a section, a series), where the platform supports view transitions and motion is
 * allowed. Everything else, including modified clicks and links to a tab root, is a normal Link.
 * It keeps `state` and `replace`, so list scroll restoration and friends are unaffected.
 *
 * The page's chunk is fetched as the finger lands, and a tap on a page that is still loading waits
 * (at most 400 ms) before sliding, so the new page does not slide in as a spinner and then jump.
 */
const TransitionLink = forwardRef(function TransitionLink({ to, replace, state, onClick, onPointerDown, onTouchStart, reloadDocument, target, ...rest }, ref) {
  const navigate = useNavigate()

  const handleClick = event => {
    onClick?.(event)
    if (event.defaultPrevented || reloadDocument || (target && target !== '_self')) return
    if (!isPlainClick(event) || !isPushedPath(pathnameOf(to)) || isInstantPath(pathnameOf(to)) || !viewTransitionsEnabled()) return
    event.preventDefault()
    const go = () => runViewTransition(() => navigate(to, { replace, state }), { direction: 'push' })
    if (isRouteReady(to)) go()
    else whenRouteReady(to).then(go)
  }

  const warm = handler => event => {
    handler?.(event)
    preloadRoute(to)
  }

  return (
    <Link
      ref={ref}
      to={to}
      replace={replace}
      state={state}
      reloadDocument={reloadDocument}
      target={target}
      onClick={handleClick}
      onPointerDown={warm(onPointerDown)}
      onTouchStart={warm(onTouchStart)}
      {...rest}
    />
  )
})

export default TransitionLink
