import { describe, expect, it, vi } from 'vitest'

vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/' }) }))

const { scannerCoversApp } = await import('./ScannerContext')

describe('scannerCoversApp', () => {
  it('only counts the scanner as open once it has loaded, so a slow or failed chunk never hides the tab bar', () => {
    expect(scannerCoversApp({ isOpen: true, ready: false })).toBe(false)
    expect(scannerCoversApp({ isOpen: true, ready: true })).toBe(true)
    expect(scannerCoversApp({ isOpen: false, ready: true })).toBe(false)
  })
})
