import { describe, expect, it } from 'vitest'
import { offlineCenterGate } from './centerGate'

describe('offlineCenterGate', () => {
  it('redirects when the queue flag is off or IndexedDB is missing', () => {
    expect(offlineCenterGate({ queueFlag: false, indexedDB: true, enabled: false })).toBe('redirect')
    expect(offlineCenterGate({ queueFlag: true, indexedDB: false, enabled: false })).toBe('redirect')
  })

  it('waits while the outbox is not created yet, instead of bouncing the page to Home', () => {
    expect(offlineCenterGate({ queueFlag: true, indexedDB: true, enabled: false })).toBe('wait')
  })

  it('shows the page once the outbox exists', () => {
    expect(offlineCenterGate({ queueFlag: true, indexedDB: true, enabled: true })).toBe('ready')
  })
})
