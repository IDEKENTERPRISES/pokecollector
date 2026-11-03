import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isTourActive, setTourActive } from './tourBus'

describe('tourBus', () => {
  it('is shared state: off at first, on while a tour shows', () => {
    expect(isTourActive()).toBe(false)
    setTourActive(true)
    expect(isTourActive()).toBe(true)
    setTourActive(false)
    expect(isTourActive()).toBe(false)
  })

  it('is the file P15 creates too (the two phases share it)', () => {
    const source = readFileSync(new URL('./tourBus.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    expect(source.startsWith('// Shared by the tour (P15) and What')).toBe(true)
    expect(source).toContain('export function useTourActive()')
    expect(source).toContain('return useSyncExternalStore(subscribe, isTourActive, isTourActive);')
  })
})
