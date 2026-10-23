import { normalizeTcgdexLanguage } from './tcgdexLanguages'

// Language-first Sets (F19): Language -> Series -> Sets. The language is part of the route, never
// component state, so Back, reload and offline all land on the same screen.
//
//   /sets                                        the landing: language list, or straight into a language
//   /sets/language/:lang                         that language's series (or its sets, when series are off)
//   /sets/language/:lang/series/:seriesKey       the sets of one series in that language
//   /sets/:setId                                 a set (ids look like sv1_en, so "language" is never a set id)

/** The per-user setting: '' (choose each time) or a TCGdex language code. */
export const SETS_DEFAULT_LANGUAGE_KEY = 'sets_default_language'

/** The language code of a route param, or null when it is not a language we know. */
export function parseSetsLanguage(value) {
  const code = normalizeTcgdexLanguage(value, '')
  return code || null
}

export function setsLanguagePath(lang) {
  return `/sets/language/${encodeURIComponent(normalizeTcgdexLanguage(lang))}`
}

export function setsSeriesPath(lang, seriesKey) {
  return `${setsLanguagePath(lang)}/series/${encodeURIComponent(seriesKey)}`
}

/** The saved default if it is still a visible language; otherwise null ("choose each time"). */
export function resolveDefaultSetsLanguage(value, visibleCodes) {
  const code = parseSetsLanguage(value)
  return code && visibleCodes.includes(code) ? code : null
}

/**
 * What `/sets` does. `codes` are the visible language codes (empty when the list could not be
 * loaded: the user's own language is then the only one we can offer).
 */
export function resolveSetsLanding({ loading, codes, fallbackCode, defaultSetting }) {
  if (loading) return { kind: 'loading' }
  // An empty list means "unknown" (request failed, offline with no saved copy), not "one language":
  // keep the language step and trust the saved default, since no real list can contradict it.
  if (!codes.length) {
    const saved = parseSetsLanguage(defaultSetting)
    return saved ? { kind: 'redirect', lang: saved } : { kind: 'select', codes: [fallbackCode] }
  }
  const available = codes
  if (available.length === 1) return { kind: 'redirect', lang: available[0] }
  const preferred = resolveDefaultSetsLanguage(defaultSetting, available)
  if (preferred) return { kind: 'redirect', lang: preferred }
  return { kind: 'select', codes: available }
}

/** Per-language figures for the selection page, from the `lang=all` sets list. */
export function summariseLanguages(sets, codes) {
  const byCode = new Map(codes.map(code => [code, { code, setCount: 0, total: 0, owned: 0, ownedKnown: false }]))
  for (const set of sets ?? []) {
    const row = byCode.get(normalizeTcgdexLanguage(set.lang, ''))
    if (!row) continue
    row.setCount += 1
    row.total += set.total ?? 0
    if (set.owned_count != null) {
      row.owned += set.owned_count
      row.ownedKnown = true
    }
  }
  return [...byCode.values()]
}

/** Where an old URL goes: `/sets?lang=ja` and `/sets/series/:key?lang=ja`. null = leave it. */
export function legacySetsRedirect({ pathname, search, storedLang, visibleCodes }) {
  const params = new URLSearchParams(search)
  const wanted = parseSetsLanguage(params.get('lang'))
  const lang = (wanted && visibleCodes.includes(wanted) && wanted)
    || (visibleCodes.includes(parseSetsLanguage(storedLang)) && parseSetsLanguage(storedLang))
    || null
  params.delete('lang')
  const rest = params.toString()
  const suffix = rest ? `?${rest}` : ''
  const series = /^\/sets\/series\/([^/]+)\/?$/.exec(pathname)
  if (series) {
    // F18 keys carry the language: "sv~ja".
    const raw = decodeURIComponent(series[1])
    const tilde = raw.lastIndexOf('~')
    const keyLang = tilde > 0 ? parseSetsLanguage(raw.slice(tilde + 1)) : null
    const key = keyLang ? raw.slice(0, tilde) : raw
    const target = keyLang && visibleCodes.includes(keyLang) ? keyLang : lang
    return target ? `${setsSeriesPath(target, key)}${suffix}` : `/sets${suffix}`
  }
  if (pathname.replace(/\/$/, '') === '/sets' && wanted && lang) return `${setsLanguagePath(lang)}${suffix}`
  return null
}

/** The language a saved `set_overview_filters` value was filtered to, or null ('all' or unusable). */
export function storedFilterLanguage(value) {
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) } catch { return null }
  }
  return parseSetsLanguage(parsed?.langFilter)
}

/** The language a set id ends in ("sv1_en" -> "en", "x_zh-tw" -> "zh-tw"), or null. */
export function languageOfSetId(setId) {
  const id = String(setId ?? '')
  const index = id.lastIndexOf('_')
  return index > 0 ? parseSetsLanguage(id.slice(index + 1)) : null
}

/** Where Back goes from a set when there is no history to return to: its language's set list. */
export function setBackPath(setId) {
  const lang = languageOfSetId(setId)
  return lang ? setsLanguagePath(lang) : '/sets'
}

/** A set's own page. The id is encoded: it is data, not a path. */
export function setPath(setId) {
  return `/sets/${encodeURIComponent(setId)}`
}
