// Who's That Pokémon on this device (engagement P7). The server derives the puzzle from the date, so
// today's and tomorrow's are fetched ahead with the splash (prefetch.js) and kept here: playable offline.
export const WTP_DAYS_KEY = 'pc.wtp.days.v1'
const KEEP_DAYS = 3
const TIMEOUT_MS = 10000
const DATE = /^\d{4}-\d{2}-\d{2}$/
const SPRITE_PATH = /^\/api\/pokedex\/images\/[a-z-]{1,20}\/\d{1,5}\.(gif|png)$/

function attempt(run, fallback = null) {
  try {
    return run()
  } catch {
    return fallback
  }
}

/** The shape GET /api/pokedex/wtp returns, checked before it is stored or shown. */
export function isPuzzle(value) {
  return Boolean(value) && typeof value === 'object'
    && typeof value.date === 'string' && DATE.test(value.date)
    && Number.isInteger(value.answer) && value.answer >= 1 && value.answer <= 1025
    && typeof value.sprite_url === 'string' && SPRITE_PATH.test(value.sprite_url)
    && Array.isArray(value.choices) && value.choices.length === 4
    && value.choices.every(choice => Number.isInteger(choice?.dex_id) && typeof choice.name === 'string' && choice.name.length > 0 && choice.name.length <= 60)
    && value.choices.some(choice => choice.dex_id === value.answer)
}

function readDays(storage) {
  const days = attempt(() => JSON.parse(storage?.getItem(WTP_DAYS_KEY) || '{}'), {})
  return days && typeof days === 'object' && !Array.isArray(days) ? days : {}
}

export function readPuzzle(date, language = 'en', storage = globalThis.localStorage) {
  const puzzle = readDays(storage)[date]
  return isPuzzle(puzzle) && puzzle.date === date && (puzzle.lang ?? 'en') === language ? puzzle : null
}

/** Store a puzzle under its date, keeping only today and the days after it. */
export function writePuzzle(puzzle, storage = globalThis.localStorage, today = puzzle?.date) {
  if (!isPuzzle(puzzle)) return false
  const days = Object.fromEntries(
    Object.entries({ ...readDays(storage), [puzzle.date]: puzzle })
      .filter(([date]) => DATE.test(date) && date >= today)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, KEEP_DAYS),
  )
  return attempt(() => {
    storage?.setItem(WTP_DAYS_KEY, JSON.stringify(days))
    return true
  }, false)
}

/** The server's puzzle for a date, or null. Never throws. */
export async function fetchPuzzle(date, { language = 'en', fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs = TIMEOUT_MS } = {}) {
  if (!fetchImpl) return null
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const params = new URLSearchParams({ date, lang: language })
    const response = await fetchImpl(`/api/pokedex/wtp?${params}`, {
      credentials: 'same-origin', cache: 'no-store', signal: controller?.signal,
    })
    if (!response?.ok) return null
    const puzzle = await response.json()
    return isPuzzle(puzzle) && puzzle.date === date ? puzzle : null
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
