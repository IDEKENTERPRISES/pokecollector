import { forwardRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { isInstantPath, isPushedPath } from '../../navigation/navConfig'
import { isPlainClick, runViewTransition, viewTransitionsEnabled } from '../../navigation/viewTransition'

function pathnameOf(to) {
  if (typeof to === 'string') return to.split('?')[0].split('#')[0]
  return to?.pathname ?? ''
}

/**
 * A router Link that slides the next page in (design doc §14 P8, Q1c) when it opens a pushed page
 * (a detail, a section, a series), where the platform supports view transitions and motion is
 * allowed. Everything else, including modified clicks and links to a tab root, is a normal Link.
 * It keeps `state` and `replace`, so list scroll restoration and friends are unaffected.
 */
const TransitionLink = forwardRef(function TransitionLink({ to, replace, state, onClick, reloadDocument, target, ...rest }, ref) {
  const navigate = useNavigate()

  const handleClick = event => {
    onClick?.(event)
    if (event.defaultPrevented || reloadDocument || (target && target !== '_self')) return
    if (!isPlainClick(event) || !isPushedPath(pathnameOf(to)) || isInstantPath(pathnameOf(to)) || !viewTransitionsEnabled()) return
    event.preventDefault()
    runViewTransition(() => navigate(to, { replace, state }), { direction: 'push' })
  }

  return <Link ref={ref} to={to} replace={replace} state={state} reloadDocument={reloadDocument} target={target} onClick={handleClick} {...rest} />
})

export default TransitionLink
