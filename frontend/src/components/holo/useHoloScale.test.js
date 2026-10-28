import { describe, expect, it } from 'vitest'
import { HOLO_REFERENCE_WIDTH, holoScaleFor } from './useHoloScale'

describe('holoScaleFor', () => {
  it('is 1 at the reference width and grows with the card', () => {
    expect(holoScaleFor(HOLO_REFERENCE_WIDTH)).toBe(1)
    expect(holoScaleFor(HOLO_REFERENCE_WIDTH * 1.6)).toBe(1.6)
    expect(holoScaleFor(HOLO_REFERENCE_WIDTH / 2)).toBe(0.5)
  })

  it('falls back to 1 when the width is unknown', () => {
    expect(holoScaleFor(0)).toBe(1)
    expect(holoScaleFor(NaN)).toBe(1)
    expect(holoScaleFor(undefined)).toBe(1)
  })
})
