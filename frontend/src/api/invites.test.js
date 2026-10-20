import { describe, expect, it } from 'vitest'
import { inviteErrorMessage, inviteLink } from './invites'

describe('inviteLink', () => {
  it('uses this site\'s own origin', () => {
    expect(inviteLink('abc', 'https://cards.example.test')).toBe('https://cards.example.test/invite/abc')
  })
})

describe('inviteErrorMessage', () => {
  it('reads a plain detail, a refusal message, or falls back', () => {
    expect(inviteErrorMessage({ response: { data: { detail: 'Username already exists' } } }, 'x')).toBe('Username already exists')
    expect(inviteErrorMessage({ response: { data: { detail: { reason: 'used', message: 'Used.' } } } }, 'x')).toBe('Used.')
    expect(inviteErrorMessage({ response: { data: {} } }, 'fallback')).toBe('fallback')
    expect(inviteErrorMessage(new Error('network'), 'fallback')).toBe('fallback')
  })
})
