import { describe, expect, it } from 'vitest'
import {
  hasActiveScanJobs,
  orderForReview,
  queueIsActive,
  isScanJobActive,
  scanAttentionCount,
  scanJobPollInterval,
} from './scanJobs'

describe('scan job presentation helpers', () => {
  it('treats only work in progress as active', () => {
    expect(isScanJobActive({ active: 2 })).toBe(true)
    expect(isScanJobActive({ active: 0, attention: 4 })).toBe(false)
  })

  it('polls active jobs and stops for completed jobs', () => {
    expect(scanJobPollInterval({ active: 1 })).toBe(3000)
    expect(scanJobPollInterval({ active: 0 })).toBe(false)
  })

  it('counts only actionable results for badges', () => {
    expect(scanAttentionCount([{ attention: 3 }, { attention: 2 }, { active: 50 }])).toBe(5)
  })

  it('detects active jobs across the inbox', () => {
    expect(hasActiveScanJobs([{ active: 0 }, { active: 1 }])).toBe(true)
    expect(hasActiveScanJobs([{ active: 0 }])).toBe(false)
  })

  it('orders the review: ready first (from the tapped scan), then recognising, then skipped', () => {
    const kinds = { 1: 'matches', 2: 'processing', 3: 'none', 4: 'matches', 5: 'waiting' }
    const items = [1, 2, 3, 4, 5].map(id => ({ id }))
    const kindOf = item => kinds[item.id]
    expect(orderForReview(items, {}, kindOf).ready.map(item => item.id)).toEqual([1, 3, 4, 5])
    const from4 = orderForReview(items, { startId: 4 }, kindOf)
    expect(from4.ready.map(item => item.id)).toEqual([4, 5, 1, 3])
    expect(from4.current.id).toBe(4)
    const skipped = orderForReview(items, { skipped: [1, 2] }, kindOf)
    expect(skipped.ready.map(item => item.id)).toEqual([3, 4, 5])
    expect(skipped.processing).toEqual([])
    expect(skipped.skipped.map(item => item.id)).toEqual([1, 2])
    expect(orderForReview([], {}, kindOf).current).toBeNull()
  })

  it('knows when the flat queue still has scans being recognised', () => {
    expect(queueIsActive({ counts: { processing: 2 } })).toBe(true)
    expect(queueIsActive({ counts: { processing: 0 } })).toBe(false)
    expect(queueIsActive(undefined)).toBe(false)
  })
})
