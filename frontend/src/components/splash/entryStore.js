// The Pokémon of the day on this device, read synchronously so the first frame never waits.
// The server picks it from the date, the same for everyone; the device keeps today's and
// tomorrow's entries (fetched ahead by prefetch.js) and has the bundled starter as a last resort.
import { STARTER } from './config'

export const DAYS_KEY = 'pc.splash.days.v1'
export const TURN_KEY = 'pc.splash.turn.v1'
const KEEP_DAYS = 3

function attempt(run, fallback = null) {
  try {
    return run()
  } catch {
    return fallback
  }
}

/** The language the server answers in for an app language: German, else English. */
export function splashLanguage(language) {
  return String(language || '').toLowerCase().startsWith('de') ? 'de' : 'en'
}

/** 'YYYY-MM-DD' in the device's time zone, `offset` whole days from `now`. */
export function localDate(offset = 0, now = new Date()) {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
}

const SPRITE_PATH = /^\/api\/pokedex\/images\/[a-z-]{1,20}\/\d{1,5}\.(gif|png)$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const STYLES = new Set(['animated', 'artwork', 'pixel'])
const positive = value => value == null || (typeof value === 'number' && value > 0)

function isFact(fact) {
  return Boolean(fact) && typeof fact === 'object'
    && typeof fact.kind === 'string'
    && typeof fact.text === 'string' && fact.text.length > 0 && fact.text.length <= 600
    && (fact.title == null || typeof fact.title === 'string')
}

/** The shape GET /api/pokedex/splash returns, checked before anything is stored or shown. */
export function isSplashEntry(value) {
  return Boolean(value)
    && typeof value === 'object'
    && Number.isInteger(value.dex_id) && value.dex_id >= 1 && value.dex_id <= 1025
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 60
    && Number.isInteger(value.generation)
    && typeof value.region === 'string'
    && Array.isArray(value.types)
    && positive(value.weight_kg) && positive(value.height_m)
    && Array.isArray(value.facts) && value.facts.length <= 10 && value.facts.every(isFact)
    && typeof value.sprite_url === 'string' && SPRITE_PATH.test(value.sprite_url)
    && (value.sprite_style == null || STYLES.has(value.sprite_style))
    && (value.date == null || DATE.test(value.date))
}

export function starterEntry(language = 'en', date = localDate()) {
  const lang = STARTER.names[language] ? language : 'en'
  return {
    date,
    dex_id: STARTER.dex_id,
    name: STARTER.names[lang],
    lang,
    generation: STARTER.generation,
    region: STARTER.region,
    types: [...STARTER.types],
    genus: STARTER.genus[lang],
    height_m: STARTER.height_m,
    weight_kg: STARTER.weight_kg,
    shiny: false,
    facts: STARTER.facts[lang] ?? STARTER.facts.en,
    sprite_url: STARTER.sprite_url,
    sprite_style: STARTER.sprite_style,
    starter: true,
  }
}

function readDays(storage) {
  const days = attempt(() => JSON.parse(storage?.getItem(DAYS_KEY) || '{}'), {})
  return days && typeof days === 'object' && !Array.isArray(days) ? days : {}
}

/** The stored entry for a date, or null. */
export function readDay(date, storage = globalThis.localStorage) {
  const entry = readDays(storage)[date]
  return isSplashEntry(entry) && entry.date === date ? entry : null
}

/** Store an entry under its date, keeping only today and the days after it. */
export function writeDay(entry, storage = globalThis.localStorage, today = localDate()) {
  if (!isSplashEntry(entry) || !entry.date) return false
  const days = Object.fromEntries(
    Object.entries({ ...readDays(storage), [entry.date]: entry })
      .filter(([date]) => DATE.test(date) && date >= today)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, KEEP_DAYS),
  )
  return attempt(() => {
    storage?.setItem(DAYS_KEY, JSON.stringify(days))
    return true
  }, false)
}

/** A counter per launch, so each launch shows the next of the day's facts. */
export function takeFactTurn(storage = globalThis.localStorage) {
  const turn = Number(attempt(() => storage?.getItem(TURN_KEY))) || 0
  attempt(() => storage?.setItem(TURN_KEY, String((turn + 1) % 1000)))
  return turn
}

export function factFor(entry, turn = 0) {
  const facts = entry?.facts ?? []
  return facts.length ? facts[((turn % facts.length) + facts.length) % facts.length] : null
}
