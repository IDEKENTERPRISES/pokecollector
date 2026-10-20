import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = { settings: {}, updateSettings: vi.fn(() => Promise.resolve()) }
vi.mock('react', () => ({ useCallback: fn => fn }))
vi.mock('../contexts/SettingsContext', () => ({ useSettings: () => state }))

const { useSetsView } = await import('./useSetsView')

describe('useSetsView', () => {
  beforeEach(() => {
    state.settings = {}
    state.updateSettings.mockClear()
  })
  it('defaults to series', () => {
    expect(useSetsView().view).toBe('series')
    state.settings = { sets_view: 'bogus' }
    expect(useSetsView().view).toBe('series')
  })
  it('reads sets', () => {
    state.settings = { sets_view: 'sets' }
    expect(useSetsView().view).toBe('sets')
  })
  it('saves through updateSettings', () => {
    useSetsView().setView('sets')
    expect(state.updateSettings).toHaveBeenCalledWith({ sets_view: 'sets' })
    useSetsView().setView('series')
    expect(state.updateSettings).toHaveBeenLastCalledWith({ sets_view: 'series' })
  })
})
