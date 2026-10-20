import clsx from 'clsx'

// Shared by the social pages (Leaderboard, Achievements, Compare): the trainer sprite in a
// Poké Ball ring, and count strings that read right at 1.

const SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated'

/**
 * The trainer's sprite (or a Poké Ball) in a ring split red over white like a Poké Ball.
 * Decorative: the trainer's name is always written next to it, so the image has no alt text.
 */
export function TrainerAvatar({ avatarId, size = 48, className = '' }) {
  return (
    <span
      aria-hidden="true"
      className={clsx('grid flex-shrink-0 place-items-center rounded-full p-[2.5px]', className)}
      style={{
        width: size,
        height: size,
        background: 'linear-gradient(to bottom, #E3350D 0 48%, #111 48% 52%, #F5F5F5 52% 100%)',
      }}
    >
      <span className="grid h-full w-full place-items-center overflow-hidden rounded-full bg-card">
        <img
          src={avatarId ? `${SPRITE_BASE}/${avatarId}.gif` : '/pokeball.svg'}
          alt=""
          className={clsx('object-contain', avatarId ? 'pixelated h-[78%] w-[78%]' : 'h-[60%] w-[60%]')}
        />
      </span>
    </span>
  )
}

/** "1 card" / "12 cards": `key` holds the plural text with {count}, `key + 'One'` the singular. */
export function countLabel(t, key, count) {
  const n = Number(count) || 0
  const text = n === 1 ? t(`${key}One`) : t(key)
  return text.replace('{count}', n.toLocaleString())
}

/** Medal tone for the podium: gold, silver and bronze energy colours. */
export const PODIUM_TYPES = { 1: 'lightning', 2: 'metal', 3: 'fighting' }
