import { describe, expect, it } from 'vitest'
import { guideBoxInFrame, guideFileName } from './scanGuideCrop'

describe('guide frame crop', () => {
  it('maps a centred guide on a portrait phone with a landscape-cropped video', () => {
    // 390x844 screen, 1080x1920 portrait video: cover scale = max(390/1080, 844/1920) = 0.4396
    const container = { left: 0, top: 0, width: 390, height: 844 }
    const guideWidth = 390 * 0.7
    const guideHeight = guideWidth * 88 / 63
    const guide = { left: (390 - guideWidth) / 2, top: (844 - guideHeight) / 2, width: guideWidth, height: guideHeight }
    const box = guideBoxInFrame(container, guide, 1080, 1920, 0)
    expect(box.x + box.w / 2).toBeCloseTo(0.5, 2)
    expect(box.y + box.h / 2).toBeCloseTo(0.5, 2)
    // Cover cuts the sides of the video, so the guide is a bigger share of the width.
    expect(box.w).toBeCloseTo(guideWidth / 0.4396 / 1080, 2)
    // Width:height of the box in video pixels is still the card's 63:88.
    expect((box.w * 1080) / (box.h * 1920)).toBeCloseTo(63 / 88, 2)
  })

  it('adds the margin and stays inside the frame', () => {
    const container = { left: 0, top: 0, width: 300, height: 300 }
    const guide = { left: 0, top: 0, width: 300, height: 300 }
    const box = guideBoxInFrame(container, guide, 300, 300, 0.1)
    expect(box).toEqual({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('gives up without usable sizes', () => {
    expect(guideBoxInFrame({ left: 0, top: 0, width: 0, height: 0 }, { left: 0, top: 0, width: 1, height: 1 }, 100, 100)).toBeNull()
  })

  it('writes the box into the file name the server reads', () => {
    expect(guideFileName('scan-1.jpg', { x: 0.118, y: 0.142, w: 0.764, h: 0.82 })).toBe('scan-1-g118_142_764_820.jpg')
    expect(guideFileName('scan-1.jpg', null)).toBe('scan-1.jpg')
  })
})
