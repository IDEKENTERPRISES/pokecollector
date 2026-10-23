import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = { settings: {}, updateSettings: vi.fn(() => Promise.resolve()) }
vi.mock('react', () => ({ useCallback: fn => fn }))
vi.mock('../contexts/SettingsContext', () => ({ useSettings: () => state }))

const { useSetsDefaultLanguage } = await import('./useSetsDefaultLanguage')

describe('useSetsDefaultLanguage', () => {
  beforeEach(() => {
    state.settings = {}
    state.updateSettings.mockClear()
  })
  it('defaults to choosing each time', () => {
    expect(useSetsDefaultLanguage().language).toBe('')
  })
  it('ignores values that are not languages', () => {
    state.settings = { sets_default_language: 'bogus' }
    expect(useSetsDefaultLanguage().language).toBe('')
  })
  it('reads and writes a language code', () => {
    state.settings = { sets_default_language: 'ja' }
    const hook = useSetsDefaultLanguage()
    expect(hook.language).toBe('ja')
    hook.setLanguage('en')
    expect(state.updateSettings).toHaveBeenCalledWith({ sets_default_language: 'en' })
    hook.setLanguage('')
    expect(state.updateSettings).toHaveBeenLastCalledWith({ sets_default_language: '' })
  })
})
