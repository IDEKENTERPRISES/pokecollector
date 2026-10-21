// The launch splash screen's choices, one line each, so the owner's answers are one-line changes.

// Milliseconds at normal speed. The CSS reads every time through custom properties that
// Splash.jsx sets from these, so the animation and its timers cannot drift apart.
export const TIMELINE = Object.freeze({
  roll: 900, // rolls in over the grass and comes to rest
  settle: 180, // rocks back once after the roll
  firstTwitchAt: 1240,
  twitch: 300, // each of the three twitches
  twitchGap: 260, // the pause after a twitch
  lid: 180, // the top half flipping open
  burst: 400, // the light from the opening ball
  flashDelay: 90, // from the ball opening to the white flash
  flash: 380, // the white flash
  popDelay: 120, // from the ball opening to the Pokémon appearing
  pop: 460, // the Pokémon scales up, with a slight overshoot
  cardDelay: 300, // from the Pokémon appearing to the info card
  card: 420,
  fadeOut: 380, // the splash fading out by itself
  skipFade: 220, // the faster fade after a tap
})

// The third twitch opens the ball half-way through.
export const OPEN_AT = TIMELINE.firstTwitchAt + 2 * (TIMELINE.twitch + TIMELINE.twitchGap) + TIMELINE.twitch / 2
export const POP_AT = OPEN_AT + TIMELINE.popDelay
export const CARD_AT = POP_AT + TIMELINE.cardDelay
// "The reveal": the Pokémon is out. Auto-continue counts from here.
export const REVEAL_AT = POP_AT

// Milliseconds after the reveal before the splash fades out by itself; null waits for a tap.
export const AUTO_CONTINUE_MS = 2500

// Under Reduce Motion: 'card' shows the revealed card, still, for REDUCED_MOTION_HOLD_MS with a
// fade; 'off' shows no splash at all.
export const REDUCED_MOTION = 'card'
export const REDUCED_MOTION_HOLD_MS = 1500

// 'everywhere', or 'standalone' for the Home Screen app only.
export const SHOW_IN = 'everywhere'

// 'kg' or 'lb'.
export const WEIGHT_UNIT = 'kg'

// Pixel sprites are scaled by a whole number (2x to 4x) to land near this size.
export const SPRITE_TARGET_PX = 144

// The next launch's Pokémon is fetched this long after the splash closes, behind the app's own
// start-up requests.
export const PREFETCH_DELAY_MS = 3000

// The first launch ever (or nothing prefetched yet). The facts are built from the numbers, the
// same way the server builds them; no Pokédex text is bundled. The sprite comes from this
// server's cache, never from GitHub, and is kept in the splash cache after the first launch.
export const STARTER = Object.freeze({
  dex_id: 25,
  names: { en: 'Pikachu', de: 'Pikachu' },
  generation: 1,
  region: 'Kanto',
  types: ['electric'],
  weight_kg: 6,
  height_m: 0.4,
  facts: {
    en: 'Pikachu is an Electric-type Pokémon from Kanto, 0.4 m tall.',
    de: 'Pikachu ist ein Pokémon vom Typ Elektro aus Kanto, 0,4 m groß.',
  },
  sprite_url: '/api/pokedex/images/animated/25.gif',
})
