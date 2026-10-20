import { useCallback } from 'react'
import { useSettings } from '../contexts/SettingsContext'

/** The `sets_view` setting (design doc OD-F): 'series' (default) or 'sets'. */
export function useSetsView() {
  const { settings, updateSettings } = useSettings()
  const view = settings?.sets_view === 'sets' ? 'sets' : 'series'
  const setView = useCallback(
    (next) => updateSettings({ sets_view: next === 'sets' ? 'sets' : 'series' }),
    [updateSettings],
  )
  return { view, setView }
}
