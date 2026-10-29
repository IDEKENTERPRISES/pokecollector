import { useLayoutEffect } from 'react'

/**
 * The card width, in CSS px, at which holo.css's texture sizes were designed: the card on the
 * iPhone sheet is this wide, so the sheet looks as it always has. A card rendered at this width
 * has --holo-scale: 1; the zoomed card (about 312 px) gets about 2.4.
 */
export const HOLO_REFERENCE_WIDTH = 130

/** --holo-scale for a card that is `width` px wide (layout width, before any CSS transform). */
export function holoScaleFor(width) {
  if (!Number.isFinite(width) || width <= 0) return 1
  return Math.round((width / HOLO_REFERENCE_WIDTH) * 1000) / 1000
}

/**
 * Keeps --holo-scale on the holo root in step with the card's rendered width, so foil textures
 * (tile sizes, line widths, parallax offsets) scale with the card: the zoomed card then shows the
 * same number of Poké Balls, cracks or glitter flecks as the card in the sheet.
 *
 * It reads offsetWidth, the layout width, which ignores transforms. The zoom overlay enlarges its
 * card with transform: scale() while pinching, and that already scales the painted textures, so
 * counting it here would scale them twice.
 *
 * The variable is written straight on the element (like useTilt's) so a React re-render of the
 * element's other inline styles never wipes it. `active` lets a conditionally rendered root
 * (the zoom card only exists when it has a foil) re-run the effect when it appears.
 */
export function useHoloScale(ref, active = true) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!active || !el) return undefined
    const apply = () => {
      el.style.setProperty('--holo-scale', String(holoScaleFor(el.offsetWidth)))
    }
    apply()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', apply)
      return () => window.removeEventListener('resize', apply)
    }
    const observer = new ResizeObserver(apply)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, active])
}
