// Pure maths for the binder's pockets: slot lists, moves, swaps, page edges and the long press.
// No React in here so the logic is unit-tested on its own. A slot is { slot_index, binder_card_id, copy_index };
// page = slot_index / pocket_layout (0-based here, 1-based on screen).

import { normalizePocketLayout } from './bookPages'

export const LONG_PRESS_MS = 350
export const LONG_PRESS_SLOP = 10
export const EDGE_ZONE = 36
export const EDGE_TURN_MS = 650
export const MAX_SLOT_INDEX = 24000

/** { page, pocket } (both 0-based) of a slot index. */
export function pocketPosition(slotIndex, layout) {
  const perPage = normalizePocketLayout(layout)
  return { page: Math.floor(slotIndex / perPage), pocket: slotIndex % perPage }
}

/** The slot index of a 0-based page and pocket. */
export function slotIndexFor(page, pocket, layout) {
  return Math.max(0, page) * normalizePocketLayout(layout) + Math.max(0, pocket)
}

/** Pages the pockets fill (an empty binder still has one). `spare` adds blank pages at the end. */
export function slotPageCount(slots, layout, spare = 0) {
  const perPage = normalizePocketLayout(layout)
  const highest = slots.reduce((max, slot) => Math.max(max, slot.slot_index), -1)
  return Math.max(1, Math.ceil((highest + 1) / perPage)) + Math.max(0, spare)
}

/** A sparse list, one entry per pocket (null for a gap), for `pages` pages: what the book draws. */
export function pocketsFromSlots(slots, layout, pages) {
  const perPage = normalizePocketLayout(layout)
  const pockets = Array.from({ length: pages * perPage }, () => null)
  for (const slot of slots) {
    if (slot.slot_index < pockets.length) pockets[slot.slot_index] = slot
  }
  return pockets
}

/**
 * Move the copy in pocket `from` to pocket `to`: into an empty pocket it moves, onto a card the two swap.
 * Returns a new list, or the same list when nothing changes (same pocket, or nothing in `from`).
 */
export function moveSlot(slots, from, to) {
  if (from === to || to < 0 || to > MAX_SLOT_INDEX) return slots
  const moving = slots.find(slot => slot.slot_index === from)
  if (!moving) return slots
  return slots.map(slot => {
    if (slot === moving) return { ...slot, slot_index: to }
    if (slot.slot_index === to) return { ...slot, slot_index: from }
    return slot
  })
}

/** Close the gaps the same way the server does: keep the order, renumber 0..n-1. */
export function compactSlots(slots) {
  return [...slots]
    .sort((a, b) => a.slot_index - b.slot_index)
    .map((slot, position) => ({ ...slot, slot_index: position }))
}

/** The body for PUT /slots. */
export function slotsRequestBody(version, slots) {
  return {
    version,
    slots: slots.map(({ slot_index, binder_card_id, copy_index }) => ({ slot_index, binder_card_id, copy_index })),
  }
}

/** -1 near the left edge of the book, 1 near the right edge, 0 elsewhere. */
export function edgeDirection(x, rect, zone = EDGE_ZONE) {
  if (x <= rect.left + zone) return -1
  if (x >= rect.right - zone) return 1
  return 0
}

/** True once a finger or mouse has travelled far enough that it is a swipe or scroll, not a hold. */
export function exceedsSlop(dx, dy, slop = LONG_PRESS_SLOP) {
  return Math.hypot(dx, dy) > slop
}

/** The pages offered by Move to…: every existing page plus one new one at the end. */
export function movePageChoices(slots, layout) {
  return slotPageCount(slots, layout, 1)
}

/** What sits in the pocket page/pocket (0-based) points at, or null for a gap. */
export function slotAt(slots, page, pocket, layout) {
  const index = slotIndexFor(page, pocket, layout)
  return slots.find(slot => slot.slot_index === index) ?? null
}
