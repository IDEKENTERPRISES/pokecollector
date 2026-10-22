import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import en from '../i18n/en'
import ScannerSettingsCard, { draftFromConfiguration } from './ScannerSettingsCard'

const t = key => key.split('.').reduce((node, part) => node?.[part], en) ?? key

// What the server sends a user who is not an administrator when an administrator sets the scanner
// for everyone: no providers, no model, no timeout.
const trainerPayload = {
  scope: 'global',
  editable: false,
  scanning_available: true,
  visual_verification: 'automatic',
}

function render(payload) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  client.setQueryData(['scanner-configuration'], payload)
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(ScannerSettingsCard, { t })),
  )
}

describe('draftFromConfiguration', () => {
  it('does not assume the payload lists providers (the trainer crash in global mode)', () => {
    expect(() => draftFromConfiguration(trainerPayload)).not.toThrow()
    expect(draftFromConfiguration(trainerPayload)).toEqual({
      provider: 'gemini',
      model: '',
      requestTimeoutSeconds: 30,
      usingCustomModel: false,
    })
  })

  it('reads an administrator payload', () => {
    const draft = draftFromConfiguration({
      provider: 'openai',
      model: 'vision-fast',
      request_timeout_seconds: 120,
      providers: [{ id: 'openai', custom_model: 'vision-fast' }],
    })
    expect(draft).toEqual({
      provider: 'openai', model: 'vision-fast', requestTimeoutSeconds: 120, usingCustomModel: true,
    })
  })
})

describe('ScannerSettingsCard for a trainer in global mode', () => {
  it('renders nothing and shows no scanner setup', () => {
    expect(render(trainerPayload)).toBe('')
  })

  it('says only that scanning is unavailable, without naming anything', () => {
    const markup = render({ ...trainerPayload, scanning_available: false })
    expect(markup).toContain("Scanning isn&#x27;t available right now. Ask your admin.")
    expect(markup).not.toMatch(/Gemini|OpenAI|model/i)
  })
})
