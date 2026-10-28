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

const Pocket = memo(function Pocket({ item, renderPocket }) {
  countPocketRender()
  if (!item) return <div className="book-pocket book-pocket-empty" aria-hidden="true" />
  return (
    <div className="book-pocket" data-testid={item.ghost ? 'book-ghost' : 'book-pocket'}>
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
  const slots = pageItems(items, pageIndex, layout)
  const filled = Array.from({ length: normalizePocketLayout(layout) }, (_, index) => slots[index] ?? null)
  return (
    <section className="book-page" data-side={side} data-page={pageIndex + 1} style={{ '--book-cols': cols }}>
      <span className="book-spine" aria-hidden="true" />
      <div className="book-pockets">
        {filled.map((item, index) => <Pocket key={item?.key ?? `empty-${index}`} item={item} renderPocket={renderPocket} />)}
      </div>
    </section>
  )
})

/**
 * Pages of pockets that turn like a binder. `items` is a flat list ({ key, number, name, ghost, ... });
 * `renderPocket(item)` draws a pocket's card. A phone shows one page, a screen of 1024 px or more a
 * two-page spread. Only the current page (spread) and its neighbours are in the DOM.
 */
export default function BookView({ items, renderPocket, pocketLayout, resetKey = '' }) {
  const { t } = useSettings()
  const layout = normalizePocketLayout(pocketLayout)
  const spread = useMatchMedia(SPREAD_QUERY)
  const perUnit = spread ? 2 : 1
  const pages = pageCount(items.length, layout)
  const units = unitCount(pages, perUnit)

  const [state, setState] = useState({ key: resetKey, page: 0 })
  const page = clampPage(state.key === resetKey ? state.page : 0, items.length, layout)
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
    setState({ key: resetKey, page: clampPage(target, items.length, layout) })
  }

  const shown = useMemo(() => renderedUnits(unit, units), [unit, units])

  const onPointerDown = event => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    pointer.current = { x: event.clientX, y: event.clientY, id: event.pointerId }
    movedRef.current = false
  }
  const onPointerMove = event => {
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
    const start = pointer.current
    pointer.current = null
    if (!start) return
    const dx = event.clientX - start.x
    if (movedRef.current && Math.abs(dx) >= SWIPE_DISTANCE) goToUnit(unit + (dx < 0 ? 1 : -1))
    else setDrag(0)
  }
  const onClickCapture = event => {
    if (movedRef.current) {
      event.preventDefault()
      event.stopPropagation()
      movedRef.current = false
    }
  }
  const onKeyDown = event => {
    if (event.key === 'ArrowLeft') goToUnit(unit - 1)
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
    <div data-testid="book-view" data-pages={pages} data-layout={layout} className="space-y-3">
      <div
        ref={viewportRef}
        className="book-viewport"
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
