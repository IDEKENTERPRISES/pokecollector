import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, Flame, Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { addToWishlist, getCard, getTodaySummary, postViewedPokemon } from '../api/client'
import { CardModal } from '../components/CardItem'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import { useOffline } from '../offline/useOffline'
import { localDate, readDay, splashLanguage } from '../components/splash/entryStore'
import { HOME_FACTS } from '../components/splash/config'
import { factLabelKey, fill, typeColour } from '../components/splash/format'
import { ensureDay } from '../components/splash/prefetch'
import WhosThatPokemon from './WhosThatPokemon'
import { priciestLabel } from './daily'
import { xpProgress } from './xp'

const viewedKey = (userId, date) => `pc.daily.viewed.${userId}.${date}`

const readFlag = (key) => {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

const writeFlag = (key) => {
  try {
    localStorage.setItem(key, '1')
  } catch {
    // the quest is only sent once more
  }
}

function Streak({ streak, t }) {
  const count = streak?.current ?? 0
  const label = count === 0 ? t('today.streakNone') : count === 1 ? t('today.streakOne') : fill(t('today.streakDays'), { count })
  return (
    <span
      className={`inline-flex min-h-[32px] items-center gap-1 rounded-full px-2.5 text-footnote font-semibold ${count > 0 ? 'bg-fill-tertiary text-yellow' : 'bg-fill-tertiary text-text-secondary'}`}
      data-testid="streak-chip"
      data-streak={count}
      title={streak?.freeze_available ? t('today.streakFreeze') : undefined}
    >
      <Flame size={16} aria-hidden="true" />
      {label}
    </span>
  )
}

function Quests({ quests, t }) {
  const done = quests.filter(quest => quest.done).length
  return (
    <div className="border-t-[0.5px] border-border px-4 py-3" data-testid="quests">
      <div className="mb-1 flex items-baseline justify-between">
        <h3 className="text-subheadline font-semibold text-text-primary">{t('today.quests')}</h3>
        <span className="text-footnote tabular-nums text-text-secondary">{fill(t('today.questsDone'), { done, total: quests.length })}</span>
      </div>
      <ul className="space-y-1">
        {quests.map(quest => (
          <li
            key={quest.id}
            data-testid={`quest-${quest.id}`}
            data-done={quest.done ? 'true' : 'false'}
            className="flex min-h-[44px] items-center gap-3"
          >
            <span
              aria-hidden="true"
              className={`grid h-6 w-6 flex-shrink-0 place-items-center rounded-full border-2 ${quest.done ? 'border-green bg-green text-on-accent' : 'border-text-tertiary'}`}
            >
              {quest.done && <Check size={14} strokeWidth={3} />}
            </span>
            <span className={`min-w-0 flex-1 text-body ${quest.done ? 'text-text-secondary line-through' : 'text-text-primary'}`}>
              {t(`today.quest.${quest.id}`)}
              <span className="sr-only">. {quest.done ? t('today.done') : t('today.notDone')}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function PokemonRow({ entry, pokemon, t, formatPrice }) {
  const [added, setAdded] = useState(false)
  const [card, setCard] = useState(null)
  const [opening, setOpening] = useState(false)
  const cheapest = pokemon?.cheapest
  const priciest = pokemon?.most_expensive
  const owned = pokemon?.owned_printings

  const wishlist = async () => {
    try {
      await addToWishlist({ card_id: cheapest.card_id, quantity: 1 })
      setAdded(true)
      toast.success(t('today.addedWishlist'))
    } catch {
      toast.error(t('today.wishlistFailed'))
    }
  }

  // CardModal fetches nothing, so load the whole card (it may not be owned) before opening it.
  const openPriciest = async () => {
    if (opening) return
    setOpening(true)
    try {
      const { data } = await getCard(priciest.card_id)
      setCard({ ...data, id: data.id ?? priciest.card_id })
    } catch {
      toast.error(t('today.openCardFailed'))
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="flex items-center gap-4 p-4">
      <img
        src={entry.sprite_url}
        alt=""
        width="72"
        height="72"
        loading="lazy"
        className="h-[72px] w-[72px] flex-shrink-0 object-contain"
        style={entry.sprite_style === 'pixel' ? { imageRendering: 'pixelated' } : undefined}
      />
      <div className="min-w-0 flex-1">
        <h3 className="text-caption-1 font-semibold uppercase tracking-wide text-text-secondary">{t('splash.todayTitle')}</h3>
        <p className="break-words font-display text-title-3 text-text-primary">{entry.name}</p>
        {owned > 0 && (
          <p className="text-footnote text-text-secondary" data-testid="pokemon-owned">
            {owned === 1 ? t('today.ownPrinting') : fill(t('today.ownPrintings'), { count: owned })}
          </p>
        )}
        {owned === 0 && cheapest && (
          <p className="text-footnote text-text-secondary" data-testid="pokemon-cheapest">
            {fill(t('today.cheapest'), { price: formatPrice(cheapest.price) })}
          </p>
        )}
        {priciest && (
          <>
          <div className="mt-0.5" data-testid="pokemon-priciest-block">
            <Link
              to={`/pokedex/${entry.dex_id}?sort=price_desc`}
              className="ios-press -mx-1 flex min-h-[44px] items-end rounded-lg px-1 text-footnote text-text-secondary"
              data-testid="pokemon-priciest"
            >
              {fill(t('today.priciest'), { price: formatPrice(priciest.price) })}
            </Link>
            <button
              type="button"
              onClick={openPriciest}
              disabled={opening}
              aria-busy={opening}
              aria-label={fill(t('today.openCard'), { name: priciestLabel(priciest) })}
              className="ios-press -mx-1 block min-h-[44px] w-full rounded-lg px-1 text-left text-footnote font-semibold text-tint disabled:opacity-60"
              data-testid="pokemon-priciest-card"
            >
              <span className="break-words">{priciestLabel(priciest)}</span>
              {opening && <Loader2 size={14} aria-hidden="true" className="ml-1.5 inline animate-spin align-[-2px]" />}
            </button>
          </div>
          {card && <CardModal card={card} onClose={() => setCard(null)} />}
          </>
        )}
      </div>
      {owned === 0 && cheapest && !added && (
        <button
          type="button"
          onClick={wishlist}
          className="ios-press min-h-[44px] flex-shrink-0 rounded-full bg-fill-tertiary px-3 text-footnote font-semibold text-tint"
        >
          {t('today.addWishlist')}
        </button>
      )}
    </div>
  )
}

/**
 * Home's Today card (engagement P7): the Pokémon of the day with what you own, the streak flame, the
 * level, three quests and Who's That Pokémon. The Pokémon and the puzzle come from the device, so
 * they show offline; quests and the streak show what the server last said.
 */
export default function DailyTodayCard() {
  const { t, language, formatPrice } = useSettings()
  const { user } = useAuth()
  const offline = useOffline()
  const queryClient = useQueryClient()
  const lang = splashLanguage(language)
  const date = localDate()
  const userId = user?.id

  const { data: entry } = useQuery({
    queryKey: ['pokemon-of-the-day', date, lang],
    queryFn: async () => (await ensureDay(date, { language: lang })) ?? null,
    initialData: () => {
      const stored = readDay(date)
      return stored?.lang === lang ? stored : undefined
    },
    staleTime: 6 * 60 * 60 * 1000,
    retry: 1,
  })
  const { data: summary } = useQuery({
    queryKey: ['today-card', userId, date],
    queryFn: () => getTodaySummary(date),
    enabled: typeof userId === 'number',
    staleTime: 30 * 1000,
    retry: false,
  })

  useEffect(() => {
    if (!entry || offline || typeof userId !== 'number' || readFlag(viewedKey(userId, date))) return
    postViewedPokemon(date)
      .then(() => {
        writeFlag(viewedKey(userId, date))
        queryClient.invalidateQueries({ queryKey: ['today-card'] })
      })
      .catch(() => {})
  }, [entry, offline, userId, date, queryClient])

  if (!entry && !summary) return null

  const xp = summary?.xp
  const tint = entry ? typeColour(entry.types) : 'var(--type-colorless)'
  return (
    <section id="today-card" aria-labelledby="today-card-title" className="scroll-mt-20 space-y-2" data-testid="today-card">
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 id="today-card-title" className="text-title-3 font-display text-text-primary">{t('today.title')}</h2>
        {summary && <Streak streak={summary.streak} t={t} />}
      </div>
      <div className="relative isolate overflow-hidden rounded-[22px] bg-card" style={{ '--today-type': tint }}>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-12 -top-14 -z-10 h-52 w-52 rounded-full opacity-30"
          style={{ background: 'radial-gradient(closest-side, var(--today-type), transparent)' }}
        />
        {xp && (
          <div className="flex items-center gap-3 px-4 pt-3" data-testid="level-row">
            <span className="rounded-full bg-fill-tertiary px-2.5 py-0.5 text-footnote font-semibold text-text-primary">
              {fill(t('today.level'), { level: xp.level })}
            </span>
            <span className="text-footnote tabular-nums text-text-secondary">{fill(t('today.xp'), { xp: xp.xp })}</span>
            {xp.next_level_at != null && (
              <span aria-hidden="true" className="relative h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-fill-tertiary">
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-tint motion-safe:transition-[width]"
                  style={{ width: `${xpProgress(xp)?.percent ?? 0}%` }}
                />
              </span>
            )}
          </div>
        )}
        {entry && (
          <div data-testid="pokemon-of-the-day">
            <PokemonRow entry={entry} pokemon={summary?.pokemon} t={t} formatPrice={formatPrice} />
            {entry.facts.length > 0 && (
              <ul className="space-y-3 border-t-[0.5px] border-border px-4 py-3">
                {entry.facts.slice(0, HOME_FACTS).map(fact => (
                  <li key={`${fact.kind}-${fact.title ?? ''}`}>
                    <p className="text-caption-1 font-semibold" style={{ color: 'color-mix(in srgb, var(--today-type) 70%, #fff)' }}>{t(factLabelKey(fact.kind))}</p>
                    <p className="text-subheadline text-text-secondary">
                      {fact.title && <strong className="font-semibold text-text-primary">{fact.title}: </strong>}
                      {fact.text}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <Link
              to={`/pokedex/${entry.dex_id}`}
              className="flex min-h-[44px] items-center justify-between border-t-[0.5px] border-border px-4 text-body text-tint ios-press"
            >
              {t('splash.todayCards')}
              <ChevronRight size={18} aria-hidden="true" />
            </Link>
          </div>
        )}
        {summary?.quests?.length > 0 && <Quests quests={summary.quests} t={t} />}
        {typeof userId === 'number' && (
          <WhosThatPokemon
            date={date}
            userId={userId}
            language={lang}
            serverPlayed={Boolean(summary?.wtp?.played)}
            streak={summary?.streak?.current ?? 0}
          />
        )}
      </div>
    </section>
  )
}
