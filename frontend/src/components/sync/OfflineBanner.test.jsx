import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import OfflineBanner from './OfflineBanner'
import StatusLine from '../ios/StatusLine'

let offline = true
let staleText = null

vi.mock('../../contexts/SettingsContext', () => ({
  useSettings: () => ({ t: key => key }),
}))

vi.mock('../../offline/useOffline', () => ({
  useOffline: () => offline,
}))

vi.mock('./StaleDataLabel', () => ({
  default: () => (staleText ? createElement('span', { 'data-testid': 'stale-data-label' }, staleText) : null),
  useStaleDataText: () => staleText,
}))

describe('OfflineBanner', () => {
  beforeEach(() => {
    offline = true
    staleText = null
  })

  it('is a status line with the offline-banner test id and the full sentence for screen readers', () => {
    const markup = renderToStaticMarkup(createElement(OfflineBanner))

    expect(markup).toContain('role="status"')
    expect(markup).toContain('data-testid="offline-banner"')
    expect(markup).toContain('sync.offlineBanner')
    expect(markup).toContain('sync.offlineShort')
  })

  it('renders nothing while online', () => {
    offline = false
    expect(renderToStaticMarkup(createElement(OfflineBanner))).toBe('')
  })
})

describe('StatusLine (inside the nav bar, which pads for the status bar)', () => {
  beforeEach(() => {
    offline = true
    staleText = null
  })

  it('shows "Offline" with the saved-data text on one line', () => {
    staleText = 'Showing saved data from 5 minutes ago'
    const markup = renderToStaticMarkup(createElement(StatusLine))

    expect(markup).toContain('data-testid="offline-banner"')
    expect(markup).toContain('data-testid="stale-data-label"')
    expect(markup.indexOf('offline-banner')).toBeLessThan(markup.indexOf('stale-data-label'))
  })

  it('shows only the offline text when nothing was saved', () => {
    const markup = renderToStaticMarkup(createElement(StatusLine))

    expect(markup).toContain('data-testid="offline-banner"')
    expect(markup).not.toContain('stale-data-label')
  })

  it('shows the saved-data text alone, without the offline banner, while online', () => {
    offline = false
    staleText = 'Showing saved data from 5 minutes ago'
    const markup = renderToStaticMarkup(createElement(StatusLine))

    expect(markup).toContain('role="status"')
    expect(markup).toContain('data-testid="stale-data-label"')
    expect(markup).not.toContain('offline-banner')
  })

  it('renders nothing when online with no saved-data text', () => {
    offline = false
    expect(renderToStaticMarkup(createElement(StatusLine))).toBe('')
  })
})
