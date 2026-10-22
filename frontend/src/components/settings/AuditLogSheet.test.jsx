import { describe, expect, it } from 'vitest'
import en from '../../i18n/en'
import { auditActionLabel, auditDetailLines, auditDetailText } from './AuditLogSheet'

const t = key => key.split('.').reduce((node, part) => node?.[part], en) ?? key

const entry = changes => ({ action: 'scanner.config.updated', details: { changes } })

describe('scanner audit entries', () => {
  it('has a label', () => {
    expect(auditActionLabel('scanner.config.updated', t)).toBe('Scanner settings changed')
  })

  it('reads each change as before → after', () => {
    const lines = auditDetailLines(entry({
      provider: { from: 'gemini', to: 'openai' },
      model: { from: 'gemini-2.5-flash', to: 'gpt-4o-mini' },
      request_timeout: { from: 30, to: 120 },
      gemini_fallback: { from: true, to: false },
      capability: { from: null, to: 'full' },
      api_key: { openai: { action: 'replaced', from: '••ab12', to: '••cd34' } },
    }), t)
    expect(lines).toEqual([
      'Provider: Gemini → OpenAI',
      'Model: gemini-2.5-flash → gpt-4o-mini',
      'Response timeout: 30 → 120 s',
      'Gemini fallback: off',
      'Visual verification: none → on',
      'OpenAI key replaced (••ab12 → ••cd34)',
    ])
  })

  it('words added and removed keys and the first setup', () => {
    expect(auditDetailLines(entry({ api_key: { gemini: { action: 'added', to: '••9999' } } }), t))
      .toEqual(['Gemini key added (••9999)'])
    expect(auditDetailLines(entry({ api_key: { openai: { action: 'removed', from: '••1234' } } }), t))
      .toEqual(['OpenAI key removed (••1234)'])
    expect(auditDetailLines(entry({ model: { from: null, to: 'vision-fast' } }), t))
      .toEqual(['Model: none → vision-fast'])
  })

  it('says whose settings were copied', () => {
    const copied = { action: 'scanner.config.updated', details: { changes: {}, copied_from: { username: 'brock' } } }
    expect(auditDetailText(copied, t)).toBe("Copied from brock's own settings")
  })

  it('never prints anything but the hint for a key', () => {
    const text = auditDetailText(entry({ api_key: { openai: { action: 'replaced', from: '••ab12', to: '••cd34' } } }), t)
    expect(text).not.toMatch(/sk-/)
  })

  it('leaves invite entries as they were', () => {
    expect(auditDetailText({ action: 'invite.created', details: { role: 'admin' } }, t)).toBe('Role admin')
    expect(auditDetailLines({ action: 'invite.revoked', details: {} }, t)).toEqual([])
  })
})
