import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
  CAMERA_DENIED_KEY,
  chooseCaptureMode,
  clearCameraDenied,
  isCameraDenial,
  readCameraDenied,
  rememberCameraDenied,
} from './scanCamera'

// The unit tests run in plain Node, so give them an in-memory sessionStorage.
beforeEach(() => {
  const store = new Map()
  vi.stubGlobal('sessionStorage', {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('chooseCaptureMode', () => {
  test('opens the camera when it is supported and was not denied', () => {
    expect(chooseCaptureMode({ supported: true, denied: false })).toBe('camera')
  })

  test('falls back when getUserMedia is missing', () => {
    expect(chooseCaptureMode({ supported: false, denied: false })).toBe('fallback')
  })

  test('falls back when the camera was denied', () => {
    expect(chooseCaptureMode({ supported: true, denied: true })).toBe('fallback')
  })

  test('falls back on a denial remembered for the session until it is cleared', () => {
    const supported = true
    expect(chooseCaptureMode({ supported, denied: readCameraDenied() })).toBe('camera')
    rememberCameraDenied()
    expect(sessionStorage.getItem(CAMERA_DENIED_KEY)).toBe('1')
    expect(chooseCaptureMode({ supported, denied: readCameraDenied() })).toBe('fallback')
    clearCameraDenied()
    expect(chooseCaptureMode({ supported, denied: readCameraDenied() })).toBe('camera')
  })
})

describe('isCameraDenial', () => {
  test('only permission refusals count as a denial', () => {
    expect(isCameraDenial({ name: 'NotAllowedError' })).toBe(true)
    expect(isCameraDenial({ name: 'NotFoundError' })).toBe(false)
    expect(isCameraDenial(null)).toBe(false)
  })
})
