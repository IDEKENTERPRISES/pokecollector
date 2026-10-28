import { describe, expect, it } from 'vitest'
import { detectHoloEngine } from './holoEngine'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1'
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

describe('detectHoloEngine', () => {
  it('uses the WebKit-safe foil on iPhone, including third-party iOS browsers', () => {
    expect(detectHoloEngine({ userAgent: IPHONE, vendor: 'Apple Computer, Inc.' })).toBe('webkit')
    expect(detectHoloEngine({ userAgent: IPHONE_CHROME, vendor: 'Google Inc.' })).toBe('webkit')
  })

  it('uses it on Safari for Mac and for iPadOS posing as a Mac', () => {
    expect(detectHoloEngine({ userAgent: MAC_SAFARI, vendor: 'Apple Computer, Inc.', maxTouchPoints: 0 })).toBe('webkit')
    expect(detectHoloEngine({ userAgent: MAC_SAFARI, vendor: 'Google Inc.', maxTouchPoints: 5 })).toBe('webkit')
  })

  it('keeps the blend-mode foil on Chromium', () => {
    expect(detectHoloEngine({ userAgent: CHROME, vendor: 'Google Inc.' })).toBe('default')
    expect(detectHoloEngine(null)).toBe('default')
  })
})
