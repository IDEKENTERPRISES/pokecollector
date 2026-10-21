// What the splash shows at launch, read synchronously so the first frame never waits:
// the entry fetched after the previous splash (localStorage), else the bundled starter.
import { STARTER } from './config'
import { MAX_DEX_ID, addToBag } from './shuffleBag'

export const NEXT_KEY = 'pc.splash.next.v1'
export const SEEN_KEY = 'pc.splash.seen.v1'

function attempt(run, fallback = null) {
  try {
    return run()
  } catch {
    return fallback
  }
}

const SPRITE_PATH = /^\/api\/pokedex\/images\/[a-z]+\/\d{1,4}\.(gif|png)$/

/** The shape GET /api/pokedex/splash returns, checked before anything is stored or shown. */
export function isSplashEntry(value) {
  return Boolean(value)
    && typeof value === 'object'
    && Number.isInteger(value.dex_id) && value.dex_id >= 1 && value.dex_id <= MAX_DEX_ID
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 60
    && Number.isInteger(value.generation)
    && typeof value.region === 'string'
    && Array.isArray(value.types)
    && (value.weight_kg == null || (typeof value.weight_kg === 'number' && value.weight_kg > 0))
    && (value.fact == null || typeof value.fact === 'string')
    && typeof value.sprite_url === 'string' && SPRITE_PATH.test(value.sprite_url)
}

export function starterEntry(language = 'en') {
  const lang = STARTER.names[language] ? language : 'en'
  return {
    dex_id: STARTER.dex_id,
    name: STARTER.names[lang],
    lang,
    generation: STARTER.generation,
    region: STARTER.region,
    types: [...STARTER.types],
    weight_kg: STARTER.weight_kg,
    height_m: STARTER.height_m,
    fact: STARTER.facts[lang] ?? STARTER.facts.en,
    sprite_url: STARTER.sprite_url,
    starter: true,
  }
}

export function readNextEntry(storage = globalThis.localStorage) {
  const value = attempt(() => JSON.parse(storage?.getItem(NEXT_KEY) || 'null'))
  return isSplashEntry(value) ? value : null
}

export function writeNextEntry(entry, storage = globalThis.localStorage) {
  if (!isSplashEntry(entry)) return false
  return attempt(() => {
    storage?.setItem(NEXT_KEY, JSON.stringify(entry))
    return true
  }, false)
}

/** The picker: the prefetched entry when there is a valid one, else the starter. */
export function pickLaunchEntry({ next, language = 'en' } = {}) {
  return isSplashEntry(next) ? next : starterEntry(language)
}

export function readSeen(storage = globalThis.localStorage) {
  return attempt(() => storage?.getItem(SEEN_KEY)) || ''
}

/** Put a species in the shuffle bag once the splash has shown it. */
export function markShown(dexId, storage = globalThis.localStorage) {
  attempt(() => storage?.setItem(SEEN_KEY, addToBag(readSeen(storage), dexId)))
}
