import { Link } from 'react-router-dom'
import { Check, MessageCircle } from 'lucide-react'
import BadgeMedal from '../../components/ios/BadgeMedal'
import HpBar from '../../components/ios/HpBar'
import { colourFor, typeVar } from '../../components/ios/pokemon'
import { useHideValues } from '../../components/ios/hideValues'
import GoalRing from '../../goals/GoalRing'
import { useSettings } from '../../contexts/SettingsContext'
import { PODIUM_TYPES, TrainerAvatar } from '../../pages/socialParts'
import { resolveCardImageUrl } from '../../utils/imageUrl'
import ReactionBar from './ReactionBar'
import { ageLabel, reactionSummary, setPathFor } from './feedFormat'

const BODY = 'ml-[52px] mt-3 flex min-h-[44px] items-center gap-3 text-left'

/** The body is a link or button when it leads somewhere, otherwise a plain block. */
function Body({ to, onClick, label, children }) {
  if (to) return <Link to={to} aria-label={label} className={`${BODY} ios-press`}>{children}</Link>
  if (onClick) return <button type="button" onClick={onClick} aria-label={label} className={`${BODY} ios-press w-[calc(100%-52px)]`}>{children}</button>
  return <div className={BODY}>{children}</div>
}

function SetSeal({ name, setKey }) {
  const type = colourFor(setKey)
  return (
    <span
      aria-hidden="true"
      className="relative grid h-12 w-12 flex-shrink-0 place-items-center rounded-full"
      style={{
        background: `linear-gradient(150deg, ${typeVar(type, 'top')}, ${typeVar(type, 'bottom')})`,
        boxShadow: `0 4px 12px color-mix(in srgb, ${typeVar(type)} 40%, transparent)`,
      }}
      data-set-name={name}
    >
      <span className="absolute inset-1 rounded-full border-[1.5px] border-dashed border-white/55" />
      <Check size={22} strokeWidth={3} color="#FFFFFF" />
    </span>
  )
}

function CardArt({ card }) {
  const src = card?.images_small || card?.image ? resolveCardImageUrl(card) : null
  const type = colourFor(card?.set_id || card?.id)
  return (
    <span
      aria-hidden="true"
      className="relative block h-[100px] w-[72px] flex-shrink-0 overflow-hidden rounded-[6px]"
      style={{
        background: `linear-gradient(150deg, ${typeVar(type, 'top')}, ${typeVar(type, 'bottom')})`,
        boxShadow: `0 6px 16px color-mix(in srgb, ${typeVar(type)} 50%, transparent)`,
      }}
    >
      {src && <img src={src} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />}
    </span>
  )
}

function PodiumMedal({ place }) {
  const type = PODIUM_TYPES[place] ?? 'colorless'
  return (
    <span
      aria-hidden="true"
      className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-full font-display text-title-2 font-extrabold"
      style={{
        background: `linear-gradient(to bottom, ${typeVar(type, 'top')}, ${typeVar(type, 'bottom')})`,
        color: type === 'lightning' ? '#1D1600' : '#fff',
        boxShadow: `0 4px 12px color-mix(in srgb, ${typeVar(type)} 40%, transparent)`,
      }}
    >
      {place}
    </span>
  )
}

/** One event of the activity feed (docs/SOCIAL_DESIGN.md §6.2). */
export default function FeedEventRow({ item, onReact, onOpenCard, onOpenComments, reactionsDisabled = false, now }) {
  const { t, formatPrice } = useSettings()
  const { hidden } = useHideValues()
  const { kind, display = {}, trainer = {}, reactions } = item
  const own = Boolean(item.mine)
  const name = own ? t('feed.you') : trainer.username
  const age = ageLabel(item.occurred_at, t, { now })
  const spokenAge = ageLabel(item.occurred_at, t, { now, spoken: true })
  const comments = Number(item.comment_count) || 0

  let sentence = t(`feed.sentence.${kind}`)
  let subject = ''
  let body = null

  if (kind === 'set_completed') {
    const total = Number(display.total) || 0
    const label = t('feed.setComplete').replace('{name}', display.set_name ?? '')
    subject = display.set_name
    body = (
      <Body to={setPathFor(display)}>
        <SetSeal name={display.set_name} setKey={display.set_key} />
        <span className="min-w-0 flex-1">
          <span className="block text-headline">{display.set_name}</span>
          <span className="block text-footnote tabular-nums text-text-secondary">
            {t('feed.setProgress').replaceAll('{total}', total.toLocaleString())}
          </span>
          <HpBar value={total} max={total} label={label} className="mt-1.5" />
        </span>
      </Body>
    )
  } else if (kind === 'achievement_unlocked') {
    const title = display.name_key ? t(display.name_key) : display.name
    const tier = display.tier ? t(`achievements.tier.${display.tier}`) : ''
    const track = display.track ? t(`achievements.track.${display.track}`) : ''
    subject = [title, tier].filter(Boolean).join(', ')
    body = (
      <Body to={own ? '/achievements' : `/achievements/${trainer.id}`}>
        <BadgeMedal track={display.track} tier={display.tier} holo size={48} />
        <span className="min-w-0 flex-1">
          <span className="block text-headline">{title}</span>
          <span className="block text-footnote text-text-secondary">
            {t('feed.badgeLine').replace('{tier}', tier).replace('{track}', track)}
          </span>
        </span>
      </Body>
    )
  } else if (kind === 'big_pull') {
    const card = display.card ?? {}
    const hasAmount = display.amount !== undefined && display.amount !== null
    const amount = hasAmount ? formatPrice(display.amount) : null
    subject = [card.name, [display.set_name, card.number].filter(Boolean).join(' '), hasAmount && !hidden ? amount : null]
      .filter(Boolean).join(', ')
    sentence = t('feed.sentence.big_pull')
    body = (
      <Body onClick={() => onOpenCard?.({ ...card, card_id: card.id })}>
        <CardArt card={card} />
        <span className="min-w-0 flex-1">
          <span className="block text-headline">{card.name}</span>
          <span className="block text-footnote text-text-secondary">
            {t('feed.cardLine').replace('{set}', display.set_name ?? '').replace('{number}', card.number ?? '')}
          </span>
          {hasAmount && (
            <span className="mt-0.5 block text-footnote font-semibold tabular-nums text-yellow">{amount}</span>
          )}
        </span>
      </Body>
    )
  } else if (kind === 'goal_completed') {
    subject = display.title
    body = (
      <Body to={own && display.goal_id ? `/goals/${display.goal_id}` : null}>
        <GoalRing percent={100} size={48} />
        <span className="min-w-0 flex-1">
          <span className="block text-headline">{display.title}</span>
          <span className="block text-footnote text-text-secondary">{t('feed.goalComplete')}</span>
        </span>
      </Body>
    )
  } else if (kind === 'challenge_finished') {
    const place = Number(display.place) || 0
    sentence = place === 1
      ? t('feed.sentence.challenge_finishedFirst')
      : place > 1 && place <= 3
        ? t('feed.sentence.challenge_finishedPlace').replace('{place}', t(`feed.place.${place}`))
        : t('feed.sentence.challenge_finished')
    const title = display.title_key ? t(display.title_key) : display.title
    subject = title
    body = (
      <Body>
        {place >= 1 && place <= 3 ? <PodiumMedal place={place} /> : <BadgeMedal track="daily" tier="bronze" size={48} holo />}
        <span className="min-w-0 flex-1">
          <span className="block text-headline">{title}</span>
          {display.week && (
            <span className="block text-footnote text-text-secondary">
              {t('feed.challengeLine').replace('{week}', display.week).replace('{place}', place ? t(`feed.ordinal.${place}`) : '')}
            </span>
          )}
        </span>
      </Body>
    )
  }

  const summary = own ? reactionSummary(reactions?.counts, t) : ''
  const ariaLabel = [
    `${name} ${sentence}${subject ? `, ${subject}` : ''}`,
    spokenAge + (summary ? `. ${summary}` : ''),
  ].join('. ')

  return (
    <article aria-label={ariaLabel} className="rounded-xl bg-card px-4 pb-1 pt-4" data-testid="feed-event" data-kind={kind}>
      <div className="flex items-center gap-3">
        <TrainerAvatar avatarId={trainer.avatar_id} size={40} />
        <div className="min-w-0 flex-1">
          <p className="text-subheadline"><span className="font-semibold">{name}</span> {sentence}</p>
          <p className="text-caption-1 text-text-secondary">{age}</p>
        </div>
        <button
          type="button"
          onClick={() => onOpenComments?.(item)}
          aria-label={comments > 0 ? t('feed.commentsOpenCount').replace('{count}', comments) : t('feed.commentsOpen')}
          data-testid="feed-comments"
          className="ios-press -my-1 -mr-3 inline-flex h-11 min-w-[44px] flex-shrink-0 items-center justify-center gap-1 rounded-full px-3 text-text-secondary focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-tint"
        >
          <MessageCircle size={20} strokeWidth={2} aria-hidden="true" />
          {comments > 0 && <span className="text-footnote font-semibold tabular-nums text-text-primary">{comments}</span>}
        </button>
      </div>
      {body}
      <ReactionBar
        counts={reactions?.counts}
        mine={reactions?.mine}
        own={own}
        disabled={reactionsDisabled}
        onToggle={kindKey => onReact?.(item, kindKey)}
      />
    </article>
  )
}
