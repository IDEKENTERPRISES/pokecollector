import { useCallback } from 'react'
import { useSettings } from '../contexts/SettingsContext'
import { SETS_DEFAULT_LANGUAGE_KEY, parseSetsLanguage } from '../utils/setsLanguage'

/** The `sets_default_language` setting: '' (choose each time) or a language code. */
export function useSetsDefaultLanguage() {
  const { settings, updateSettings } = useSettings()
  const language = parseSetsLanguage(settings?.[SETS_DEFAULT_LANGUAGE_KEY]) ?? ''
  const setLanguage = useCallback(
    (next) => updateSettings({ [SETS_DEFAULT_LANGUAGE_KEY]: parseSetsLanguage(next) ?? '' }),
    [updateSettings],
  )
  return { language, setLanguage }
}
