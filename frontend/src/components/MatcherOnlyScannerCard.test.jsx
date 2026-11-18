import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import en from '../i18n/en'
import ScannerSetupSection from './MatcherOnlyScannerCard'

const t = key => key.split('.').reduce((node, part) => node?.[part], en) ?? key

const adminPayload = {
  scope: 'user', editable: true, provider: 'openai', model: 'vision-fast', request_timeout_seconds: 120, status: 'ready',
  visual_verification: 'automatic', providers: [{ id: 'openai', label: 'OpenAI-compatible', models: ['vision-fast'], requires_api_key: false }],
}

function render(props, payload = adminPayload) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  client.setQueryData(['scanner-configuration'], payload)
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ScannerSetupSection, { t, ...props })))
}

describe('Settings › Scanner while Matcher only is on', () => {
  it('replaces the editor with a short read-only card for a non-admin', () => {
    const html = render({ matcherOnly: true, isAdmin: false })
    expect(html).toContain('Card scanner')
    expect(html).toContain('Scanning uses the picture matcher (set by your admin).')
    expect(html).not.toContain('are kept and come back')
    expect(html).not.toMatch(/vision-fast|API key|Test/)
  })

  it('does the same for an admin, with one extra line that the AI settings are kept', () => {
    const html = render({ matcherOnly: true, isAdmin: true })
    expect(html).toContain('Scanning uses the picture matcher (set by your admin).')
    expect(html).toContain('Your AI scanner settings are kept and come back when you switch off Matcher only (no AI)')
    expect(html).not.toContain('vision-fast')
  })

  it('shows the editor again when the switch is off', () => {
    for (const isAdmin of [true, false]) {
      const html = render({ matcherOnly: false, isAdmin })
      expect(html).not.toContain('Scanning uses the picture matcher')
      expect(html).not.toContain('matcher-only-scanner-card') // the normal editor (or its loading state) is back
    }
  })

  it('makes no scanner-config request for the hidden editor', () => {
    const queryFn = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryDefaults(['scanner-configuration'], { queryFn })
    renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ScannerSetupSection, { t, matcherOnly: true, isAdmin: true })))
    expect(queryFn).not.toHaveBeenCalled()
    expect(client.getQueryCache().find({ queryKey: ['scanner-configuration'] })).toBeUndefined()
  })
})
