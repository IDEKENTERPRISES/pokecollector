import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { Check, ChevronRight, CloudOff, Target, Trophy } from 'lucide-react'
import { getChallenge } from '../../api/client'
import BadgeMedal from '../../components/ios/BadgeMedal'
import EnergyIcon from '../../components/ios/EnergyIcon'
import HpBar from '../../components/ios/HpBar'
import { TYPE_COLOURS, typeKeyFor, typeVar } from '../../components/ios/pokemon'
import { fill } from '../../components/splash/format'
import { useAuth } from '../../contexts/AuthContext'
import { useSettings } from '../../contexts/SettingsContext'
import { useOffline } from '../../offline/useOffline'
import { PODIUM_TYPES, TrainerAvatar } from '../../pages/socialParts'
import { tierLabelKey } from '../../progress/achievements'
import {
  CHALLENGE_QUERY_KEY, badgeCount, finishersOf, formatWhen, fractionOf, leftKey, placeKey, podiumSlots, resultLine, timeLeft, weekNumber,
} from './challengeFormat'

const locale = () => document.documentElement.lang || undefined

/** Re-renders once a minute so the countdown stays right while the screen is open. */
export function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/**
 * This week's challenge (GET /api/challenge, 404 while social is off). The last answer stays on screen
 * offline; `saved` says the answer on screen is a copy (offline, or the server can't be reached).
 */
export function useChallenge(enabled = true) {
  const offline = useOffline()
  const { user } = useAuth()
  const query = useQuery({
    queryKey: CHALLENGE_QUERY_KEY,
    queryFn: getChallenge,
    enabled: enabled && typeof user?.id === 'number',
    staleTime: 30 * 1000,
    refetchOnMount: 'always',
    retry: false,
  })
  const unreachable = query.isError && !query.error?.response
  return { ...query, viewerId: user?.id, saved: Boolean(query.data) && (offline || unreachable) }
}

// --- words ---------------------------------------------------------------------------------

/** "Sort 20 cards into binders": the catalogue title for the challenge, else a plain fallback. */
export function challengeTitle(t, challenge) {
  const text = challenge ? t(`challenge.${challenge.id}`) : ''
  if (!challenge || typeof text !== 'string' || text === `challenge.${challenge.id}`) return t('challenge.generic')
  return fill(text, { target: challenge.target })
}

function challengeCounts(t, challenge) {
  const text = challenge ? t(`challenge.${challenge.id}Counts`) : ''
  return text && text !== `challenge.${challenge.id}Counts` ? text : ''
}

/** "2 days left", "5 hours left", "Ended". */
export function leftText(t, endsAt, now) {
  const named = leftKey(timeLeft(endsAt, now))
  return named ? fill(t(`challenge.${named.key}`), { count: named.count }) : ''
}

const placeText = (t, place) => {
  const key = placeKey(place)
  return key ? t(`challenge.${key}`) : String(place)
}

// --- the Today card row (§7.3) -------------------------------------------------------------

function OfflineMark({ label }) {
  return (
    <span className="inline-flex items-center gap-1" title={label}>
      <CloudOff size={14} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  )
}

function FinishersLine({ finishers, t }) {
  const names = finishers.map(entry => entry.user.username)
  let text
  if (names.length === 0) text = t('challenge.beTheFirst')
  else if (names.length === 1) text = fill(t('challenge.finishersOne'), { a: names[0] })
  else if (names.length === 2) text = fill(t('challenge.finishersTwo'), { a: names[0], b: names[1] })
  else if (names.length === 3) text = fill(t('challenge.finishersThree'), { a: names[0], b: names[1], c: names[2] })
  else text = fill(t('challenge.finishersMany'), { a: names[0], b: names[1], count: names.length - 2 })
  return (
    <div className="mt-1.5 flex items-center gap-2">
      {finishers.length > 0 && (
        <span aria-hidden="true" className="flex">
          {finishers.slice(0, 3).map((entry, index) => (
            <span key={entry.user.id} data-testid="challenge-finisher" className={clsx('rounded-full', index > 0 && '-ml-1.5')} style={{ boxShadow: '0 0 0 2px var(--color-card)' }}>
              <TrainerAvatar avatarId={entry.user.avatar_id} size={20} ring={1.5} />
            </span>
          ))}
        </span>
      )}
      <span className="text-footnote text-text-secondary">{text}</span>
    </div>
  )
}

/** The weekly challenge inside Home's Today card, under the daily quests. */
export function ChallengeTodayRow({ enabled = true }) {
  const { t } = useSettings()
  const now = useMinuteClock()
  const { data, viewerId, saved } = useChallenge(enabled)
  if (!data?.challenge) return null

  const { challenge, me, board } = data
  const title = challengeTitle(t, challenge)
  const target = challenge.target
  const done = Math.min(me?.progress ?? 0, target)
  const finished = Boolean(me?.finished_at) || (me?.progress ?? 0) >= target
  const place = placeKey(me?.place) && finished ? placeText(t, me.place) : null
  const status = finished ? (place ? fill(t('challenge.finishedPlace'), { place }) : t('challenge.finished')) : null
  const counts = fill(t('challenge.ofTarget'), { done: me?.progress ?? 0, target })
  const ariaLabel = status
    ? fill(t('challenge.todayRowFinishedLabel'), { title, status })
    : fill(t('challenge.todayRowLabel'), { title, done: me?.progress ?? 0, target })
  const key = typeKeyFor(challenge.type) ?? 'colorless'
  return (
    <div className="border-t-[0.5px] border-border px-4 py-3" data-testid="challenge-today-row">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="text-subheadline font-semibold text-text-primary">{t('challenge.generic')}</h3>
        <span className="flex items-center gap-1.5 text-footnote tabular-nums text-text-secondary">
          {saved && <OfflineMark label={t('challenge.offlineSaved')} />}
          {leftText(t, data.ends_at, now)}
        </span>
      </div>
      <Link to="/leaderboard/challenge" aria-label={ariaLabel} className="ios-press flex min-h-[44px] items-center gap-3">
        <span
          aria-hidden="true"
          className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-full"
          style={{ background: `linear-gradient(150deg, var(--type-${key}-top), var(--type-${key}-bottom))`, color: TYPE_COLOURS[key].text }}
        >
          <Trophy size={22} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-body text-text-primary">{status ?? title}</span>
          <span className="block text-footnote tabular-nums text-text-secondary">{status ? title : counts}</span>
        </span>
        <ChevronRight size={18} strokeWidth={2.25} className="flex-shrink-0 text-text-tertiary" aria-hidden="true" />
      </Link>
      <HpBar
        className="mt-2"
        value={done}
        max={target}
        label={fill(t('challenge.todayProgressLabel'), { done: me?.progress ?? 0, target })}
      />
      {!(finished && finishersOf(board, viewerId).length === 0) && <FinishersLine finishers={finishersOf(board, viewerId)} t={t} />}
    </div>
  )
}

// --- the hero (§7.4) -----------------------------------------------------------------------

export function ChallengeHero({ data, now, thisWeek = false }) {
  const { t } = useSettings()
  const { challenge, me } = data
  const key = typeKeyFor(challenge.type) ?? 'colorless'
  const ink = TYPE_COLOURS[key].text
  const title = challengeTitle(t, challenge)
  const target = challenge.target
  const progress = me?.progress ?? 0
  const remaining = Math.max(0, target - progress)
  const finished = Boolean(me?.finished_at) || remaining === 0
  const week = thisWeek
    ? t('challenge.thisWeek')
    : fill(t('challenge.weekLabel'), { week: weekNumber(data.week) ?? '' })
  const when = formatWhen(data.ends_at, locale(), { long: true })
  const eyebrow = fill(t('challenge.heroLine'), { week, when: when ?? '', left: leftText(t, data.ends_at, now) })
  const more = remaining === 1 ? t('challenge.moreToFinishOne') : fill(t('challenge.moreToFinish'), { count: remaining })
  const percent = fractionOf(progress, target) * 100
  return (
    <section
      aria-labelledby="challenge-title"
      data-testid="challenge-hero"
      className="relative overflow-hidden rounded-[22px] p-4"
      style={{
        color: ink,
        background: `linear-gradient(150deg, var(--type-${key}-top), var(--type-${key}-bottom))`,
        boxShadow: `0 8px 20px color-mix(in srgb, var(--type-${key}) 55%, transparent)`,
      }}
    >
      <span aria-hidden="true" className="pointer-events-none absolute -bottom-3 -right-3 opacity-20">
        <EnergyIcon type={key} size={84} />
      </span>
      <p className="relative text-footnote font-semibold">{eyebrow}</p>
      <h1 id="challenge-title" className="relative mt-1 text-title-2 font-display">{title}</h1>
      <div className="relative mt-3 flex items-baseline gap-1.5">
        <span className="text-tile-number font-display tabular-nums">{progress}</span>
        <span className="text-headline tabular-nums">/ {target}</span>
        <span className="ml-auto text-footnote">{finished ? t('challenge.finished') : more}</span>
      </div>
      <div
        role="progressbar"
        aria-label={fill(t('challenge.progressLabel'), { done: progress, target })}
        aria-valuemin={0}
        aria-valuemax={target}
        aria-valuenow={Math.min(progress, target)}
        className="relative mt-2 h-2 overflow-hidden rounded-full bg-black/25"
      >
        <div
          className="h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500"
          style={{ width: `${percent}%`, background: ink }}
        />
      </div>
    </section>
  )
}

// --- the podium (§7.5) ---------------------------------------------------------------------

const SIZES = {
  md: { avatar: 40, blocks: { 1: 72, 2: 56, 3: 44 }, number: 'text-title-2' },
  lg: { avatar: 48, blocks: { 1: 104, 2: 76, 3: 56 }, number: 'text-title-1' },
}
const ORDER = { 1: 2, 2: 1, 3: 3 }
const OPEN_EDGE = '1.5px dashed var(--color-text-tertiary)'

/** Places 1 to 3 in an ordered list; CSS `order` draws them 2nd, 1st, 3rd. A place nobody holds is a dashed outline. */
export function PodiumList({ entries, size = 'md', target, viewerId, rise = false, label }) {
  const { t } = useSettings()
  const spec = SIZES[size]
  return (
    <ol
      aria-label={label ?? t('challenge.podiumTitle')}
      className="grid grid-cols-3 items-end gap-2"
      style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}
      data-testid="challenge-podium"
    >
      {podiumSlots(entries).map(({ place, entry }) => {
        const ordinal = placeText(t, place)
        const height = spec.blocks[place]
        const style = { order: ORDER[place] }
        if (!entry) {
          return (
            <li key={place} className="flex min-w-0 flex-col items-center text-center" style={style} aria-label={fill(t('challenge.podiumRowOpen'), { place: ordinal })} data-place={place}>
              <span aria-hidden="true" className="box-border rounded-full" style={{ width: spec.avatar, height: spec.avatar, border: OPEN_EDGE }} />
              <span className="mt-1 text-footnote font-semibold text-text-secondary">{t('challenge.podiumOpen')}</span>
              <span className="text-caption-1 text-text-secondary">{fill(t('challenge.placeName'), { place: ordinal })}</span>
              <span
                aria-hidden="true"
                className={clsx('mt-1.5 box-border grid w-full place-items-center text-text-secondary', spec.number)}
                style={{ height, borderRadius: '12px 12px 0 0', border: OPEN_EDGE, borderBottom: 0 }}
              >
                {place}
              </span>
            </li>
          )
        }
        const me = entry.user?.id === viewerId
        const name = me ? t('challenge.you') : entry.user?.username
        const finished = Boolean(entry.finished_at)
        const caption = finished ? formatWhen(entry.finished_at, locale()) : fill(t('challenge.ofTarget'), { done: entry.progress, target })
        const spoken = finished
          ? fill(t('challenge.podiumRowFinished'), { place: ordinal, name: me ? name.toLowerCase() : name, when: formatWhen(entry.finished_at, locale(), { long: true }) })
          : fill(t('challenge.podiumRowCount'), { place: ordinal, name: me ? name.toLowerCase() : name, done: entry.progress, target })
        const type = PODIUM_TYPES[place]
        return (
          <li key={place} className="flex min-w-0 flex-col items-center text-center" style={style} aria-label={spoken} data-place={place}>
            <TrainerAvatar avatarId={entry.user?.avatar_id} size={spec.avatar} />
            <span className="mt-1 max-w-full truncate text-footnote font-semibold">{name}</span>
            <span className="text-caption-1 text-text-secondary">{caption}</span>
            <span
              aria-hidden="true"
              className={clsx('mt-1.5 grid w-full place-items-center', spec.number, rise && 'podium-rise')}
              style={{
                height,
                borderRadius: '12px 12px 0 0',
                background: `linear-gradient(to bottom, ${typeVar(type, 'top')}, ${typeVar(type, 'bottom')})`,
                color: type === 'lightning' ? '#1D1600' : '#fff',
              }}
            >
              {place}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

// Weeks whose finished podium already rose in this session: it rises on the first view only.
const risen = new Set()
export function useRiseOnce(week, active) {
  const [rise] = useState(() => Boolean(active) && !risen.has(week))
  useEffect(() => {
    if (active && week) risen.add(week)
  }, [active, week])
  return rise
}

// --- the board (§7.4) ----------------------------------------------------------------------

export function ChallengeBoard({ board, viewerId, challenge }) {
  const { t } = useSettings()
  const target = challenge.target
  return (
    <section aria-labelledby="challenge-board-title">
      <h2 id="challenge-board-title" className="px-4 pb-1.5 text-footnote text-text-secondary">{t('challenge.trainers')}</h2>
      <ul role="list" className="overflow-hidden rounded-xl bg-card" data-testid="challenge-board">
        {board.map((entry, index) => {
          const me = entry.user?.id === viewerId
          const name = me ? t('challenge.you') : entry.user?.username
          const finished = Boolean(entry.finished_at)
          const status = finished
            ? fill(t('challenge.finishedWhen'), { when: formatWhen(entry.finished_at, locale()) })
            : fill(t('challenge.ofTarget'), { done: entry.progress, target })
          const ordinal = entry.place ? `${placeText(t, entry.place)}, ` : ''
          const spoken = finished
            ? fill(t('challenge.rowFinished'), { place: ordinal, name, when: formatWhen(entry.finished_at, locale(), { long: true }), done: entry.progress, target })
            : fill(t('challenge.rowCount'), { place: ordinal, name, done: entry.progress, target })
          const type = entry.place ? PODIUM_TYPES[entry.place] : null
          return (
            <li
              key={entry.user?.id ?? index}
              aria-label={spoken}
              data-testid="challenge-board-row"
              className={clsx('relative flex min-h-[60px] items-center gap-3 px-4 py-2.5', me && 'bg-elevated')}
            >
              {index > 0 && <span aria-hidden="true" className="absolute right-0 top-0 h-[0.5px] bg-border" style={{ left: 84 }} />}
              <span
                aria-hidden="true"
                className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-full bg-fill-tertiary text-caption-1 font-black"
                style={type ? {
                  background: `linear-gradient(to bottom, ${typeVar(type, 'top')}, ${typeVar(type, 'bottom')})`,
                  color: type === 'lightning' ? '#1D1600' : '#fff',
                } : undefined}
              >
                {entry.place ?? ''}
              </span>
              <TrainerAvatar avatarId={entry.user?.avatar_id} size={32} ring={2} />
              <span className="min-w-0 flex-1">
                <span className={clsx('block truncate text-body', me && 'font-semibold')}>{name}</span>
                <span className="block text-footnote text-text-secondary">{status}</span>
              </span>
              <span aria-hidden="true" className="w-16 flex-shrink-0"><HpBar value={entry.progress} max={target} /></span>
              <span aria-hidden="true" className="w-10 flex-shrink-0 text-right text-footnote font-semibold tabular-nums">{entry.progress}/{target}</span>
            </li>
          )
        })}
      </ul>
      <p className="px-4 pt-1.5 text-footnote text-text-secondary" data-testid="challenge-footer">
        {fill(t('challenge.footer'), { counts: challengeCounts(t, challenge) }).trim()}
      </p>
    </section>
  )
}

// --- last week's result (§7.6) -------------------------------------------------------------

export function ChallengeResultCard({ last }) {
  const { t } = useSettings()
  const { user } = useAuth()
  const { challenge, me, podium } = last
  const target = challenge.target
  const line = resultLine(me)
  const when = formatWhen(me?.finished_at, locale())
  const done = line.progress ?? me?.progress ?? 0
  const lineText = {
    finishedPlace: () => fill(t('challenge.youFinishedPlace'), { place: placeText(t, line.place), when: when ?? '' }),
    finished: () => t('challenge.youFinished'),
    placed: () => fill(t('challenge.youCame'), { place: placeText(t, line.place), done, target }),
    reached: () => fill(t('challenge.youReached'), { done, target }),
  }[line.kind]()
  const won = line.kind === 'finishedPlace' || line.kind === 'finished'
  const total = last.trainer_count
  const countText = total === 1
    ? fill(t('challenge.resultFinishedCountOne'), { done: last.finished_count })
    : fill(t('challenge.resultFinishedCount'), { done: last.finished_count, total })
  const badge = last.badge
  const count = badgeCount(badge?.id)
  return (
    <section aria-labelledby="challenge-result-title" className="rounded-[22px] bg-card p-4" data-testid="challenge-result">
      <p className="text-footnote font-semibold text-text-secondary">{fill(t('challenge.resultTitle'), { week: weekNumber(last.week) ?? '' })}</p>
      <h2 id="challenge-result-title" className="mt-0.5 text-title-3 font-display">{challengeTitle(t, challenge)}</h2>
      <div className="mt-4">
        <PodiumList entries={podium} size="lg" target={target} viewerId={user?.id} rise={false} />
      </div>
      <p className="mt-3 text-center text-footnote text-text-secondary">{countText}</p>
      <div className="mt-3 flex min-h-[44px] items-center gap-3" data-testid="challenge-result-line">
        <span
          aria-hidden="true"
          className={clsx('grid h-[29px] w-[29px] flex-shrink-0 place-items-center rounded-[7px]', won ? 'bg-green' : 'bg-fill-tertiary')}
        >
          {won ? <Check size={18} strokeWidth={2.5} color="#000" /> : <Target size={18} strokeWidth={2.25} />}
        </span>
        <p className="text-body">{lineText}</p>
      </div>
      {badge && (
        <Link to="/achievements" className="ios-press flex min-h-[44px] items-center gap-3" data-testid="challenge-result-badge">
          <BadgeMedal track="daily" tier={badge.tier} glyph="trophy" size={29} />
          <span className="min-w-0 flex-1">
            <span className="block text-body">
              {fill(t('challenge.badgeLine'), { name: t(`achievements.challenge${count}`), tier: t(tierLabelKey(badge.tier)) })}
            </span>
            <span className="block text-footnote text-text-secondary">
              {count === 1 ? t('challenge.badgeCountOne') : fill(t('challenge.badgeCount'), { count })}
            </span>
          </span>
          <ChevronRight size={18} strokeWidth={2.25} className="flex-shrink-0 text-text-tertiary" aria-hidden="true" />
        </Link>
      )}
    </section>
  )
}
