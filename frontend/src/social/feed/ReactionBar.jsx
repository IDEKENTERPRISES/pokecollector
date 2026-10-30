import clsx from 'clsx'
import { Flame, Heart, PartyPopper, Sparkles } from 'lucide-react'
import { useSettings } from '../../contexts/SettingsContext'
import { REACTION_ORDER, reactionLabel } from './feedFormat'

const GLYPHS = { cheer: PartyPopper, wow: Sparkles, fire: Flame, heart: Heart }

/**
 * The four one-tap reactions of an event (docs/SOCIAL_DESIGN.md §6.3): 44 px buttons holding a 36 px
 * capsule. Yours are tinted in the accent. On your own events (`own`) the capsules are plain counts:
 * you can see that people reacted, never who, and you can't react to yourself.
 */
export default function ReactionBar({ counts, mine = [], own = false, onToggle, disabled = false }) {
  const { t } = useSettings()
  const kinds = own ? REACTION_ORDER.filter(kind => (counts?.[kind] ?? 0) > 0) : REACTION_ORDER
  if (own && kinds.length === 0) return null

  return (
    <div className="ml-[52px] mt-1 flex flex-wrap gap-x-2" role={own ? undefined : 'group'} aria-label={own ? undefined : t('feed.reactions')} aria-hidden={own ? 'true' : undefined}>
      {kinds.map((kind) => {
        const Glyph = GLYPHS[kind]
        const count = counts?.[kind] ?? 0
        const reacted = mine.includes(kind)
        const capsule = (
          <span
            className={clsx(
              'inline-flex h-9 items-center gap-1.5 rounded-full px-3',
              reacted ? 'bg-accent/20 text-tint' : 'bg-fill-tertiary text-text-secondary',
            )}
          >
            <Glyph size={18} strokeWidth={2} aria-hidden="true" />
            {count > 0 && (
              <span className={clsx('text-footnote font-semibold tabular-nums', !reacted && 'text-text-primary')}>{count}</span>
            )}
          </span>
        )
        if (own) {
          return <span key={kind} className="inline-flex h-11 items-center">{capsule}</span>
        }
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={reacted}
            aria-label={reactionLabel(t(`feed.reaction.${kind}`), count, reacted, t)}
            disabled={disabled}
            onClick={() => onToggle?.(kind)}
            className="ios-press inline-flex h-11 items-center disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-tint motion-safe:active:[&>span]:scale-[1.15]"
          >
            {capsule}
          </button>
        )
      })}
    </div>
  )
}
