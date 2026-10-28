// Pure helpers for the book view: pocket layouts, page splitting, collector-number order and the
// per-device Grid | Book preference. No React in here so the logic is unit-tested on its own.

export const DEFAULT_POCKET_LAYOUT = 9

const LAYOUT_GRIDS = {
  4: { cols: 2, rows: 2 },
  9: { cols: 3, rows: 3 },
  12: { cols: 4, rows: 3 },
}

/** A supported pocket count (4, 9 or 12); anything else falls back to the 3x3 default. */
export function normalizePocketLayout(value) {
  const layout = Number(value)
  return LAYOUT_GRIDS[layout] ? layout : DEFAULT_POCKET_LAYOUT
}

export function gridForLayout(value) {
  return LAYOUT_GRIDS[normalizePocketLayout(value)]
}

/** How many pages `total` items fill; an empty book still has one (empty) page. */
export function pageCount(total, layout = DEFAULT_POCKET_LAYOUT) {
  const perPage = normalizePocketLayout(layout)
  return Math.max(1, Math.ceil(Math.max(0, total) / perPage))
}

/** The items on one page (a short last page stays short; the view draws the empty pockets). */
export function pageItems(items, pageIndex, layout = DEFAULT_POCKET_LAYOUT) {
  const perPage = normalizePocketLayout(layout)
  return items.slice(pageIndex * perPage, (pageIndex + 1) * perPage)
}

export function splitPages(items, layout = DEFAULT_POCKET_LAYOUT) {
  return Array.from({ length: pageCount(items.length, layout) }, (_, index) => pageItems(items, index, layout))
}

/** Which page holds the item at `itemIndex`. */
export function pageOfIndex(itemIndex, layout = DEFAULT_POCKET_LAYOUT) {
  return Math.floor(Math.max(0, itemIndex) / normalizePocketLayout(layout))
}

export function clampPage(page, total, layout) {
  const last = pageCount(total, layout) - 1
  const value = Number.isFinite(Number(page)) ? Math.trunc(Number(page)) : 0
  return Math.min(last, Math.max(0, value))
}

/**
 * The "units" a book turns through: one page on a phone, a two-page spread on a wide screen.
 * Returns the page indexes of unit `unitIndex`.
 */
export function unitPages(unitIndex, pagesPerUnit, totalPages) {
  const first = unitIndex * pagesPerUnit
  return Array.from({ length: pagesPerUnit }, (_, offset) => first + offset).filter(page => page < totalPages)
}

export function unitCount(totalPages, pagesPerUnit) {
  return Math.max(1, Math.ceil(totalPages / pagesPerUnit))
}

/** The units that are rendered: the current one and its neighbours. */
export function renderedUnits(current, totalUnits) {
  return [current - 1, current, current + 1].filter(unit => unit >= 0 && unit < totalUnits)
}

function numberSortKey(value) {
  const text = value == null ? '' : String(value)
  const match = text.match(/^(\D*)(\d+)(.*)$/)
  if (!match) return [text.toLowerCase(), Number.MAX_SAFE_INTEGER, '']
  return [match[1].toLowerCase(), Number(match[2]), match[3].toLowerCase()]
}

/** Collector-number order: 2 before 10, TG02 after 100, same as the set grid's "number" sort. */
export function compareCollectorNumbers(a, b) {
  const left = numberSortKey(a)
  const right = numberSortKey(b)
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * Book items for a set page: `tiles` are the page's tiles ({ key, card, source }), already filtered
 * (and already one per variant when Split variants is on). They go in collector-number order; the sort
 * is stable, so a card's variants stay together in their given order. A tile that is not owned is a ghost.
 */
export function setBookItems(tiles) {
  return tiles
    .map((tile, index) => ({ tile, index }))
    .sort((a, b) => compareCollectorNumbers(a.tile.source?.number ?? a.tile.card?.number, b.tile.source?.number ?? b.tile.card?.number) || a.index - b.index)
    .map(({ tile }) => ({
      key: tile.key,
      card: tile.card,
      source: tile.source,
      number: tile.source?.number ?? tile.card?.number ?? '',
      name: tile.card?.name ?? '',
      ghost: !(tile.card?.owned || Number(tile.card?.owned_quantity) > 0),
    }))
}

const VIEW_KEY_PREFIX = 'pc-book-view:'

/** 'book' or 'grid', remembered per device and per page kind ('set', 'binder'). Never throws. */
export function readViewPreference(kind) {
  try {
    return window.localStorage.getItem(VIEW_KEY_PREFIX + kind) === 'book' ? 'book' : 'grid'
  } catch {
    return 'grid'
  }
}

export function writeViewPreference(kind, view) {
  try {
    window.localStorage.setItem(VIEW_KEY_PREFIX + kind, view === 'book' ? 'book' : 'grid')
  } catch {
    // storage blocked: the choice just isn't remembered
  }
}
