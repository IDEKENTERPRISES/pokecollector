import { describe, expect, it } from 'vitest'
import { isTourActive, setTourActive } from './tourBus'

describe('tourBus', () => {
  it('is off until a tour shows and follows setTourActive', () => {
    expect(isTourActive()).toBe(false)
    setTourActive(true)
    expect(isTourActive()).toBe(true)
    setTourActive(true)
    setTourActive(false)
    expect(isTourActive()).toBe(false)
  })
})
