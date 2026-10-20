import { describe, expect, it } from 'vitest'
import { compactAmount } from './SettingsContext'

describe('compactAmount', () => {
  it('shows the full amount below 1,000', () => {
    expect(compactAmount(999.99, '£')).toBe('£999.99')
    expect(compactAmount(0, '£')).toBe('£0.00')
  })
  it('compacts thousands with one decimal, dropped when .0', () => {
    expect(compactAmount(1000, '£')).toBe('£1k')
    expect(compactAmount(1049, '£')).toBe('£1k')
    expect(compactAmount(1050, '£')).toBe('£1.1k')
    expect(compactAmount(12345, '£')).toBe('£12.3k')
    expect(compactAmount(12500, '£')).toBe('£12.5k')
  })
  it('rolls over to millions', () => {
    expect(compactAmount(999999, '£')).toBe('£1M')
    expect(compactAmount(1200000, '£')).toBe('£1.2M')
  })
  it('keeps the sign and the currency symbol', () => {
    expect(compactAmount(-1500, '£')).toBe('-£1.5k')
    expect(compactAmount(-5, '$')).toBe('-$5.00')
    expect(compactAmount(-1200000, '€')).toBe('-€1.2M')
  })
})
