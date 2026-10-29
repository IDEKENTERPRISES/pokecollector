import { describe, expect, it } from 'vitest'
import {
  compactSlots,
  edgeDirection,
  exceedsSlop,
  movePageChoices,
  moveSlot,
  pocketPosition,
  pocketsFromSlots,
  slotAt,
  slotIndexFor,
  slotPageCount,
  slotsRequestBody,
} from './slotLayout'

const slot = (slot_index, binder_card_id, copy_index = 0) => ({ slot_index, binder_card_id, copy_index })

describe('pocket positions', () => {
  it('derives page and pocket from the slot index and the page size', () => {
    expect(pocketPosition(0, 9)).toEqual({ page: 0, pocket: 0 })
    expect(pocketPosition(10, 9)).toEqual({ page: 1, pocket: 1 })
    expect(pocketPosition(10, 4)).toEqual({ page: 2, pocket: 2 })
    expect(pocketPosition(11, 12)).toEqual({ page: 0, pocket: 11 })
  })

  it('round-trips and keeps the slot index when the page size changes', () => {
    expect(slotIndexFor(1, 1, 9)).toBe(10)
    expect(pocketPosition(slotIndexFor(3, 2, 12), 12)).toEqual({ page: 3, pocket: 2 })
    // a card in pocket 10 stays in pocket 10; only the page it lands on changes
    expect(pocketPosition(10, 12).page).toBe(0)
    expect(pocketPosition(10, 4).page).toBe(2)
  })

  it('falls back to 9 pockets for an unknown size', () => {
    expect(pocketPosition(10, 7)).toEqual({ page: 1, pocket: 1 })
  })
})

describe('pages and pockets', () => {
  it('counts the pages the slots reach, with a minimum of one and optional spare pages', () => {
    expect(slotPageCount([], 9)).toBe(1)
    expect(slotPageCount([slot(8, 1)], 9)).toBe(1)
    expect(slotPageCount([slot(9, 1)], 9)).toBe(2)
    expect(slotPageCount([slot(9, 1)], 9, 1)).toBe(3)
    expect(movePageChoices([slot(0, 1)], 4)).toBe(2)
  })

  it('lays the slots out with real gaps', () => {
    const pockets = pocketsFromSlots([slot(0, 1), slot(3, 2)], 4, 2)
    expect(pockets).toHaveLength(8)
    expect(pockets[0].binder_card_id).toBe(1)
    expect(pockets[1]).toBeNull()
    expect(pockets[3].binder_card_id).toBe(2)
    expect(pockets[7]).toBeNull()
  })

  it('finds what sits at a page and pocket', () => {
    const slots = [slot(10, 5)]
    expect(slotAt(slots, 1, 1, 9).binder_card_id).toBe(5)
    expect(slotAt(slots, 0, 1, 9)).toBeNull()
  })
})

describe('moving and swapping', () => {
  const slots = [slot(0, 1), slot(1, 2), slot(5, 3)]

  it('moves a card into an empty pocket and leaves a gap behind', () => {
    const next = moveSlot(slots, 0, 3)
    expect(next.map(s => [s.slot_index, s.binder_card_id])).toEqual([[3, 1], [1, 2], [5, 3]])
    expect(slots[0].slot_index).toBe(0)
  })

  it('swaps two cards when the target is occupied', () => {
    const next = moveSlot(slots, 0, 1)
    expect(next.map(s => [s.slot_index, s.binder_card_id])).toEqual([[1, 1], [0, 2], [5, 3]])
  })

  it('does nothing for the same pocket, an empty origin or an impossible target', () => {
    expect(moveSlot(slots, 1, 1)).toBe(slots)
    expect(moveSlot(slots, 4, 2)).toBe(slots)
    expect(moveSlot(slots, 0, -1)).toBe(slots)
  })

  it('moves to a new page', () => {
    expect(moveSlot(slots, 5, 18).find(s => s.binder_card_id === 3).slot_index).toBe(18)
  })

  it('keeps every copy placed exactly once and no pocket twice', () => {
    const next = moveSlot(moveSlot(slots, 0, 5), 5, 9)
    expect(new Set(next.map(s => s.slot_index)).size).toBe(next.length)
    expect(next).toHaveLength(slots.length)
  })

  it('closes gaps in order', () => {
    expect(compactSlots([slot(7, 3), slot(2, 1), slot(30, 2)]).map(s => [s.slot_index, s.binder_card_id])).toEqual([[0, 1], [1, 3], [2, 2]])
  })

  it('builds the PUT body from plain slots', () => {
    expect(slotsRequestBody('abc', [{ ...slot(1, 2, 3), extra: true }])).toEqual({ version: 'abc', slots: [slot(1, 2, 3)] })
  })
})

describe('drag helpers', () => {
  const rect = { left: 20, right: 380 }

  it('detects the page edges', () => {
    expect(edgeDirection(30, rect)).toBe(-1)
    expect(edgeDirection(370, rect)).toBe(1)
    expect(edgeDirection(200, rect)).toBe(0)
  })

  it('treats small wobble as a hold and real travel as a swipe', () => {
    expect(exceedsSlop(3, 4)).toBe(false)
    expect(exceedsSlop(12, 0)).toBe(true)
    expect(exceedsSlop(0, -11)).toBe(true)
  })
})
