import { describe, expect, it, vi } from 'vitest'

const post = vi.fn().mockResolvedValue({ data: {} })
vi.mock('./client', () => ({ default: { post: (...args) => post(...args), get: vi.fn(), delete: vi.fn() } }))

const { createInvite, inviteErrorMessage, inviteLink } = await import('./invites')

describe('createInvite', () => {
  it('never sends a role: every invite creates a trainer', async () => {
    await createInvite({ expiresInDays: 30, note: 'for Brock', role: 'admin' })
    expect(post).toHaveBeenCalledWith('/auth/invites', { expires_in_days: 30, note: 'for Brock' })
  })
})

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
