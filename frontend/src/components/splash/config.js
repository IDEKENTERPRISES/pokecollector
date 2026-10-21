// The launch splash screen's choices, one line each, so the owner's answers are one-line changes.

// Milliseconds at normal speed. The CSS reads every time through custom properties that
// Splash.jsx sets from these, so the animation and its timers cannot drift apart.
export const TIMELINE = Object.freeze({
  roll: 900, // rolls in over the ground and comes to rest
  settle: 180, // rocks back once after the roll
  firstTwitchAt: 1240,
  twitch: 300, // each twitch
  twitchGap: 260, // the pause after a twitch
  lid: 180, // the top half flipping open
  burst: 400, // the light from the opening ball, in the type's colour
  flashDelay: 90, // from the ball opening to the flash
  flash: 380, // the flash, tinted with the type's colour
  popDelay: 120, // from the ball opening to the Pokémon appearing
  pop: 460, // the Pokémon scales up, with a slight overshoot
  boxDelay: 160, // from the Pokémon appearing to the "Wild … appeared!" box
  perLetter: 28, // the box types its text out
  cardDelay: 300, // from the Pokémon appearing to the Pokédex card
  card: 420,
  sparkle: 700, // one twinkle of a shiny's sparkles
  fadeOut: 380, // the splash fading out by itself
  skipFade: 220, // the faster fade after a tap
})

const TWITCH_EVERY = TIMELINE.twitch + TIMELINE.twitchGap
// The third twitch opens the ball half-way through, when today's Pokémon is ready by then.
export const OPEN_TWITCH_AT = TIMELINE.firstTwitchAt + 2 * TWITCH_EVERY
export const OPEN_AT = OPEN_TWITCH_AT + TIMELINE.twitch / 2
export const POP_AT = OPEN_AT + TIMELINE.popDelay
export const CARD_AT = POP_AT + TIMELINE.cardDelay
// "The reveal": the Pokémon is out. Auto-continue counts from here.
export const REVEAL_AT = POP_AT
export { TWITCH_EVERY }

// While today's Pokémon is still loading (no pre-fetched entry), the ball keeps twitching, like a
// wobbling catch, at most this many times; then the bundled starter comes out instead.
export const WAIT_TWITCHES = 4

// Milliseconds after the reveal before the splash opens the app by itself; null waits for a tap.
export const AUTO_CONTINUE_MS = 2500

// Under Reduce Motion: 'card' shows the revealed card, still, for REDUCED_MOTION_HOLD_MS with a
// fade; 'off' shows no splash at all.
export const REDUCED_MOTION = 'card'
export const REDUCED_MOTION_HOLD_MS = 1500

// 'everywhere' (the Home Screen app, Safari and desktop), or 'standalone' for the Home Screen app.
export const SHOW_IN = 'everywhere'

// 'both' (6.0 kg · 13.2 lbs), 'metric' or 'imperial'.
export const UNITS = 'both'

// Extras: the "Wild … appeared!" pixel box and a shiny's sparkles.
export const SHOW_WILD_BOX = true
export const SHOW_SHINY_SPARKLES = true

// Home's "Pokémon of the day" card shows this many of the day's facts (the splash shows one per
// launch, in turn).
export const HOME_FACTS = 3

// The visible Pokémon is scaled to land near this size (at 6 px art pixels; larger screens scale
// it up). Animated and artwork sprites scale smoothly, up to MAX_SMOOTH_SCALE; pixel sprites by
// whole numbers.
export const SPRITE_TARGET_PX = 132
export const MAX_SMOOTH_SCALE = 2

// After the splash closes, tomorrow's Pokémon and its sprite are fetched this long later, behind
// the app's own start-up requests.
export const PREFETCH_DELAY_MS = 3000

// If the splash's own code has not rendered after this long (a slow first-launch network), the
// black cover closes and the app shows, for this launch only.
export const CHUNK_WAIT_MS = 2500

// How long the splash waits for today's entry when nothing was pre-fetched.
export const TODAY_TIMEOUT_MS = 6000

// When today's Pokémon cannot be fetched in time (offline on a first launch). Its facts are
// written for this app from game data; no Pokédex text is bundled. The sprite comes from this
// server's cache, never from GitHub, and is kept in the splash cache after the first launch.
export const STARTER = Object.freeze({
  dex_id: 25,
  names: { en: 'Pikachu', de: 'Pikachu' },
  genus: { en: 'Mouse Pokémon', de: 'Maus-Pokémon' },
  generation: 1,
  region: 'Kanto',
  types: ['electric'],
  weight_kg: 6,
  height_m: 0.4,
  facts: {
    en: [
      { kind: 'signature-move', title: 'Volt Tackle', text: 'Only its family learns it: a full-power electric charge that also hurts the user.' },
      { kind: 'evolution', text: 'Evolves into Raichu with a Thunder Stone.' },
    ],
    de: [
      { kind: 'signature-move', title: 'Volttackle', text: 'Nur seine Familie erlernt sie: ein elektrischer Sturmangriff, der auch den Anwender verletzt.' },
      { kind: 'evolution', text: 'Entwickelt sich mit Donnerstein zu Raichu.' },
    ],
  },
  sprite_url: '/api/pokedex/images/showdown/25.gif',
  sprite_style: 'animated',
})
