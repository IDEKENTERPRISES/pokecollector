import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { useSettings } from '../../contexts/SettingsContext'
import Sheet from '../ui/Sheet'
import {
  clampPage,
  gridForLayout,
  normalizePocketLayout,
  pageCount,
  pageItems,
  renderedUnits,
  unitCount,
  unitPages,
} from './bookPages'
import { EDGE_TURN_MS, LONG_PRESS_MS, edgeDirection, exceedsSlop } from './slotLayout'
import './book.css'

const SWIPE_DISTANCE = 48
const SPREAD_QUERY = '(min-width: 1024px)'

function useMatchMedia(query) {
  const [matches, setMatches] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false))
  useEffect(() => {
    if (!window.matchMedia) return undefined
    const list = window.matchMedia(query)
    const update = () => setMatches(list.matches)
    update()
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [query])
  return matches
}

// Counts pocket renders so a spec can prove a swipe does not re-render the pockets.
function countPocketRender() {
  if (typeof window !== 'undefined') window.__bookPocketRenders = (window.__bookPocketRenders ?? 0) + 1
}

const Pocket = memo(function Pocket({ item, slotIndex, renderPocket }) {
  countPocketRender()
  // data-slot-index lets the drag find the pocket under the finger without any React state.
  if (!item) return <div className="book-pocket book-pocket-empty" data-testid="book-gap" data-slot-index={slotIndex} aria-hidden="true" />
  return (
    <div className="book-pocket" data-testid={item.ghost ? 'book-ghost' : 'book-pocket'} data-slot-index={slotIndex} data-filled="true">
      <div className={clsx(item.ghost && 'opacity-80')}>{renderPocket(item)}</div>
      {item.ghost && (
        <span className="book-ghost-label">
          <span className="book-ghost-number">{item.number}</span>
          <span className="book-ghost-name">{item.name}</span>
        </span>
      )}
    </div>
  )
})

const Page = memo(function Page({ items, pageIndex, layout, side, renderPocket }) {
  const { cols } = gridForLayout(layout)
  const perPage = normalizePocketLayout(layout)
  const slots = pageItems(items, pageIndex, layout)
  const filled = Array.from({ length: perPage }, (_, index) => slots[index] ?? null)
  return (
    <section className="book-page" data-side={side} data-page={pageIndex + 1} style={{ '--book-cols': cols }}>
      <span className="book-spine" aria-hidden="true" />
      <div className="book-pockets">
        {filled.map((item, index) => (
          <Pocket key={item?.key ?? `empty-${index}`} item={item} slotIndex={pageIndex * perPage + index} renderPocket={renderPocket} />
        ))}
      </div>
    </section>
  )
})

/**
 * Pages of pockets that turn like a binder. `items` is a flat list ({ key, number, name, ghost, ... }); a `null`
 * entry is an empty pocket (a real gap). `renderPocket(item)` draws a pocket's card. A phone shows one page, a
 * screen of 1024 px or more a two-page spread. Only the current page (spread) and its neighbours are in the DOM.
 *
 * With `onMoveSlot` the cards can be dragged (docs/ENGAGEMENT_DESIGN.md P5): a 350 ms hold lifts a card, dropping on a
 * pocket calls `onMoveSlot(fromIndex, toIndex)`, holding near the left or right edge turns the page, and releasing a
 * lifted card without moving it calls `onHold(index)`. The lifted card moves through a ref and CSS variables, never
 * React state, so a drag does not re-render the pockets.
 */
export default function BookView({ items, renderPocket, pocketLayout, resetKey = '', onMoveSlot, onHold, initialPage = 0 }) {
  const { t } = useSettings()
  const layout = normalizePocketLayout(pocketLayout)
  const spread = useMatchMedia(SPREAD_QUERY)
  const perUnit = spread ? 2 : 1
  const editable = typeof onMoveSlot === 'function'
  // While a card is lifted the book gains a spare page at the end, so it can start a new page.
  const [dragging, setDragging] = useState(false)
  const totalItems = items.length + (dragging ? layout : 0)
  const pages = pageCount(totalItems, layout)
  const units = unitCount(pages, perUnit)

  const [state, setState] = useState({ key: resetKey, page: initialPage })
  const page = clampPage(state.key === resetKey ? state.page : 0, totalItems, layout)
  const unit = Math.min(units - 1, Math.floor(page / perUnit))
  const viewportRef = useRef(null)
  // The drag offset is a CSS variable set straight on the element: a swipe never re-renders React.
  const setDrag = px => viewportRef.current?.style.setProperty('--book-drag', `${px}px`)
  // The caller's renderPocket may change identity every render; pockets see one stable function.
  const renderRef = useRef(renderPocket)
  renderRef.current = renderPocket
  const stableRenderPocket = useCallback(item => renderRef.current(item), [])
  const [turning, setTurning] = useState(false)
  const [goToOpen, setGoToOpen] = useState(false)
  const [goToValue, setGoToValue] = useState('')
  const pointer = useRef(null)
  const movedRef = useRef(false)
  const holdRef = useRef(null)
  const dragRef = useRef(null)
  const suppressClickRef = useRef(false)

  const goToUnit = target => {
    const next = Math.min(units - 1, Math.max(0, target))
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    setTurning(!reduced)
    setDrag(0)
    setState({ key: resetKey, page: next * perUnit })
  }

  const goToPage = target => {
    setTurning(false)
    setDrag(0)
    setState({ key: resetKey, page: clampPage(target, totalItems, layout) })
  }

  // The drag handlers live in timers and listeners; they read the latest props through this ref.
  const actionsRef = useRef({})
  actionsRef.current = { turn: direction => goToUnit(unit + direction), onMoveSlot, onHold }

  const shown = useMemo(() => renderedUnits(unit, units), [unit, units])

  const clearHold = () => {
    if (holdRef.current) clearTimeout(holdRef.current.timer)
    holdRef.current = null
  }

  const markTarget = element => {
    const drag = dragRef.current
    if (!drag || drag.targetEl === element) return
    if (drag.targetEl) delete drag.targetEl.dataset.target
    drag.targetEl = element
    if (element) element.dataset.target = '1'
  }

  const hitTest = (x, y) => {
    const drag = dragRef.current
    if (!drag) return
    const under = document.elementFromPoint(x, y)?.closest?.('[data-slot-index]')
    const inside = under && viewportRef.current?.contains(under) && !under.closest('[inert]')
    markTarget(inside ? under : null)
  }

  const armEdgeTurn = direction => {
    const drag = dragRef.current
    if (!drag) return
    clearTimeout(drag.edgeTimer)
    drag.edgeTimer = null
    drag.edgeDirection = direction
    if (!direction) return
    drag.edgeTimer = setTimeout(() => {
      const current = dragRef.current
      if (!current || current.edgeDirection !== direction) return
      markTarget(null)
      actionsRef.current.turn(direction)
      // Look again under the finger once the new page is in place, then keep turning while it stays at the edge.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const live = dragRef.current
        if (!live) return
        hitTest(live.x, live.y)
        armEdgeTurn(direction)
      }))
    }, EDGE_TURN_MS)
  }

  const moveLift = (x, y) => {
    const drag = dragRef.current
    drag.x = x
    drag.y = y
    drag.travel = Math.max(drag.travel, Math.hypot(x - drag.startX, y - drag.startY))
    drag.clone.style.setProperty('--lift-x', `${x - drag.width / 2}px`)
    drag.clone.style.setProperty('--lift-y', `${y - drag.height / 2}px`)
    hitTest(x, y)
    const rect = viewportRef.current.getBoundingClientRect()
    const direction = edgeDirection(x, rect)
    if (direction !== drag.edgeDirection) armEdgeTurn(direction)
  }

  const lift = () => {
    const hold = holdRef.current
    holdRef.current = null
    if (!hold || !hold.element.isConnected) return
    pointer.current = null
    movedRef.current = false
    setDrag(0)
    try {
      viewportRef.current.setPointerCapture(hold.id)
    } catch {
      // the pointer already ended: the lift is dropped by the next event
    }
    const rect = hold.element.getBoundingClientRect()
    const clone = hold.element.cloneNode(true)
    clone.removeAttribute('data-slot-index')
    clone.removeAttribute('data-testid')
    clone.setAttribute('aria-hidden', 'true')
    clone.setAttribute('inert', '')
    clone.classList.add('book-lifted')
    clone.style.width = `${rect.width}px`
    clone.style.height = `${rect.height}px`
    document.body.appendChild(clone)
    hold.element.dataset.lifted = '1'
    suppressClickRef.current = true
    dragRef.current = {
      id: hold.id,
      from: hold.slotIndex,
      element: hold.element,
      clone,
      width: rect.width,
      height: rect.height,
      startX: hold.x,
      startY: hold.y,
      x: hold.x,
      y: hold.y,
      travel: 0,
      targetEl: null,
      edgeTimer: null,
      edgeDirection: 0,
    }
    setDragging(true)
    moveLift(hold.x, hold.y)
  }

  const finishDrag = commit => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    clearTimeout(drag.edgeTimer)
    const target = drag.targetEl
    const toIndex = target ? Number(target.dataset.slotIndex) : null
    if (target) delete target.dataset.target
    delete drag.element.dataset.lifted
    drag.clone.remove()
    try {
      viewportRef.current?.releasePointerCapture(drag.id)
    } catch {
      // already released
    }
    setDragging(false)
    setTimeout(() => { suppressClickRef.current = false }, 350)
    if (!commit) return
    if (toIndex != null && toIndex !== drag.from) actionsRef.current.onMoveSlot?.(drag.from, toIndex)
    else if (drag.travel <= 10 || toIndex === drag.from) actionsRef.current.onHold?.(drag.from)
  }

  useEffect(() => {
    // A touch drag must not scroll the page. iOS only honours this from a non-passive listener.
    const block = event => { if (dragRef.current && event.cancelable) event.preventDefault() }
    window.addEventListener('touchmove', block, { passive: false })
    return () => {
      window.removeEventListener('touchmove', block)
      clearTimeout(holdRef.current?.timer)
      if (dragRef.current) {
        clearTimeout(dragRef.current.edgeTimer)
        dragRef.current.clone.remove()
        dragRef.current = null
      }
    }
  }, [])

  const onPointerDown = event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (dragRef.current) return
    pointer.current = { x: event.clientX, y: event.clientY, id: event.pointerId }
    movedRef.current = false
    clearHold()
    const element = editable ? event.target.closest?.('[data-filled="true"]') : null
    if (element && !element.closest('[inert]')) {
      holdRef.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        element,
        slotIndex: Number(element.dataset.slotIndex),
        timer: setTimeout(lift, LONG_PRESS_MS),
      }
    }
  }
  const onPointerMove = event => {
    const drag = dragRef.current
    if (drag) {
      if (drag.id === event.pointerId) moveLift(event.clientX, event.clientY)
      return
    }
    const hold = holdRef.current
    if (hold && hold.id === event.pointerId && exceedsSlop(event.clientX - hold.x, event.clientY - hold.y)) clearHold()
    const start = pointer.current
    if (!start || start.id !== event.pointerId) return
    const dx = event.clientX - start.x
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(event.clientY - start.y)) {
      movedRef.current = true
      setTurning(false)
      setDrag(dx)
    }
  }
  const endPointer = event => {
    clearHold()
    if (dragRef.current) {
      pointer.current = null
      finishDrag(event.type !== 'pointercancel')
      return
    }
    const start = pointer.current
    pointer.current = null
    if (!start) return
    const dx = event.clientX - start.x
    if (movedRef.current && Math.abs(dx) >= SWIPE_DISTANCE) goToUnit(unit + (dx < 0 ? 1 : -1))
    else setDrag(0)
  }
  const onClickCapture = event => {
    if (suppressClickRef.current) {
      event.preventDefault()
      event.stopPropagation()
      suppressClickRef.current = false
      movedRef.current = false
      return
    }
    if (movedRef.current) {
      event.preventDefault()
      event.stopPropagation()
      movedRef.current = false
    }
  }
  const onKeyDown = event => {
    if (event.key === 'Escape' && dragRef.current) finishDrag(false)
    else if (event.key === 'ArrowLeft') goToUnit(unit - 1)
    else if (event.key === 'ArrowRight') goToUnit(unit + 1)
  }

  const label = perUnit === 2 && unitPages(unit, perUnit, pages).length > 1
    ? t('book.pagesOfTotal').replace('{from}', unit * perUnit + 1).replace('{to}', unit * perUnit + 2).replace('{total}', pages)
    : t('book.pageOfTotal').replace('{page}', page + 1).replace('{total}', pages)

  const submitGoTo = event => {
    event.preventDefault()
    const number = Number.parseInt(goToValue, 10)
    if (Number.isFinite(number)) goToPage(number - 1)
    setGoToOpen(false)
  }

  return (
    <div data-testid="book-view" data-pages={pages} data-layout={layout} data-dragging={dragging ? 'true' : undefined} className="space-y-3">
      <div
        ref={viewportRef}
        className={clsx('book-viewport', editable && 'book-viewport-editable')}
        role="group"
        aria-roledescription="carousel"
        aria-label={t('book.label')}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onClickCapture={onClickCapture}
        onContextMenu={editable ? event => event.preventDefault() : undefined}
        onDragStart={event => event.preventDefault()}
      >
        {shown.map(index => {
          const rel = index - unit
          const indexes = unitPages(index, perUnit, pages)
          return (
            <div
              key={index}
              data-testid={rel === 0 ? 'book-current' : 'book-neighbour'}
              aria-hidden={rel === 0 ? undefined : true}
              inert={rel === 0 ? undefined : ''}
              className={clsx('book-unit', indexes.length > 1 && 'book-unit-spread', rel !== 0 && 'book-unit-neighbour', turning && 'book-unit-turning')}
              style={{ transform: `translateX(calc(${rel * 100}% + var(--book-drag, 0px)))` }}
            >
              {indexes.map((pageIndex, offset) => (
                <Page
                  key={pageIndex}
                  items={items}
                  pageIndex={pageIndex}
                  layout={layout}
                  side={indexes.length > 1 ? (offset === 0 ? 'left' : 'right') : 'single'}
                  renderPocket={stableRenderPocket}
                />
              ))}
            </div>
          )
        })}
      </div>

      <div className="flex items-center justify-between gap-2">
        <button type="button" className="book-pager-button ios-press" onClick={() => goToUnit(unit - 1)} disabled={unit <= 0} aria-label={t('book.previousPage')}>
          <ChevronLeft size={20} aria-hidden="true" />
        </button>
        <button
          type="button"
          data-testid="book-page-button"
          className="ios-press min-h-[44px] rounded-full bg-fill-tertiary px-4 text-footnote font-semibold tabular-nums"
          onClick={() => { setGoToValue(String(page + 1)); setGoToOpen(true) }}
          aria-haspopup="dialog"
        >
          {label}
        </button>
        <button type="button" className="book-pager-button ios-press" onClick={() => goToUnit(unit + 1)} disabled={unit >= units - 1} aria-label={t('book.nextPage')}>
          <ChevronRight size={20} aria-hidden="true" />
        </button>
      </div>

      <Sheet isOpen={goToOpen} onClose={() => setGoToOpen(false)} title={t('book.goToPage')}>
        <form className="space-y-3 p-4" onSubmit={submitGoTo}>
          <label className="block text-footnote text-text-secondary" htmlFor="book-go-to-page">
            {t('book.pageRange').replace('{total}', pages)}
          </label>
          <input
            id="book-go-to-page"
            type="number"
            inputMode="numeric"
            min={1}
            max={pages}
            value={goToValue}
            onChange={event => setGoToValue(event.target.value)}
            className="input w-full"
            autoFocus
          />
          <button type="submit" className="btn-primary w-full justify-center">{t('book.go')}</button>
        </form>
      </Sheet>
    </div>
  )
}
