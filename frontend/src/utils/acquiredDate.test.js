import { describe, expect, it } from 'vitest'
import { acquiredDateInputValue, formatAcquiredDate, oldestAcquiredByCard } from './acquiredDate'

describe('added date helpers', () => {
  it('reads the calendar day without timezone shifting', () => {
    expect(acquiredDateInputValue('2025-03-04T23:59:59')).toBe('2025-03-04')
    expect(acquiredDateInputValue(null)).toBe('')
    expect(acquiredDateInputValue('garbage')).toBe('')
  })

  it('formats a date for display and tolerates missing values', () => {
    expect(formatAcquiredDate('2025-03-04T23:59:59', 'en')).toContain('2025')
    expect(formatAcquiredDate(null, 'en')).toBeNull()
  })

  it('finds the oldest added date across versions of the same card', () => {
    const oldest = oldestAcquiredByCard([
      { card_id: 'a_en', added_at: '2025-05-01T10:00:00' },
      { card_id: 'a_en', added_at: '2024-01-15T08:00:00' },
      { card_id: 'b_en', added_at: '2025-02-02T08:00:00' },
      { card_id: 'c_en', added_at: null },
      { card_id: 'd_en', added_at: '2025-06-01T10:00:00', acquired_at: '2023-12-25T00:00:00' },
    ])
    expect(oldest.get('a_en')).toBe('2024-01-15')
    expect(oldest.get('b_en')).toBe('2025-02-02')
    expect(oldest.has('c_en')).toBe(false)
    expect(oldest.get('d_en')).toBe('2023-12-25')
  })
})
