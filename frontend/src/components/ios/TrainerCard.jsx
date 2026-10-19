import { useSettings } from '../../contexts/SettingsContext'
import GymBadges from './GymBadges'
import PokeBall from './PokeBall'

/**
 * Profile trainer card (design doc §5.5, §7.12): an accent gradient card with holo shine and a
 * Poké Ball watermark, the trainer's sprite in a white ring, name, "@handle" (only when the
 * public profile is on), "ID No." padded to five digits, three stats and, in multi-user mode,
 * a row of gym badges.
 *
 * user: { name, handle, id, sprite }; stats: { cards, sets, pokedex } (display strings);
 * badges: { earned, total, to } or omitted (single-user mode).
 */
export default function TrainerCard({ user = {}, stats = {}, badges, className = '' }) {
  const { t } = useSettings()
  const idText = user.id != null && user.id !== '' ? String(user.id).padStart(5, '0') : null
  const statItems = [
    { key: 'cards', label: t('ios.cards'), value: stats.cards },
    { key: 'sets', label: t('ios.sets'), value: stats.sets },
    { key: 'pokedex', label: t('ios.pokedex'), value: stats.pokedex },
  ]

  return (
    <div
      className={`holo relative overflow-hidden rounded-[22px] p-4 text-on-accent ${className}`}
      style={{
        background: 'linear-gradient(145deg, color-mix(in srgb, var(--color-accent) 92%, white) 0%, var(--color-accent) 45%, var(--color-brand-red-dark) 100%)',
        boxShadow: '0 10px 28px color-mix(in srgb, var(--color-accent) 40%, transparent)',
      }}
    >
      <span aria-hidden="true" className="pointer-events-none absolute -right-8 -top-8 opacity-20">
        <PokeBall size={170} top="#fff" />
      </span>

      <div className="relative flex items-center gap-3.5">
        <span className="grid h-[68px] w-[68px] flex-shrink-0 place-items-center overflow-hidden rounded-full bg-black/25 ring-[3px] ring-white">
          {user.sprite
            ? <img src={user.sprite} alt="" width={64} height={64} className="h-16 w-16 object-contain" />
            : <PokeBall size={40} />}
        </span>
        <div className="min-w-0">
          <p className="truncate text-title-1 font-display">{user.name}</p>
          {user.handle && <p className="truncate text-subheadline opacity-90">@{user.handle}</p>}
          {idText && <p className="text-footnote tabular-nums opacity-80">{t('ios.idNo')} {idText}</p>}
        </div>
      </div>

      <dl className="relative mt-4 grid grid-cols-3 gap-2 rounded-2xl bg-black/20 px-3 py-2.5 text-center">
        {statItems.map(item => (
          <div key={item.key} className="min-w-0">
            <dd className="truncate text-title-3 font-display tabular-nums">{item.value ?? '–'}</dd>
            <dt className="text-caption-1 opacity-85">{item.label}</dt>
          </div>
        ))}
      </dl>

      {badges && (
        <div className="relative mt-3">
          <GymBadges earned={badges.earned} total={badges.total} to={badges.to} label={t('ios.gymBadges')} />
        </div>
      )}
    </div>
  )
}
