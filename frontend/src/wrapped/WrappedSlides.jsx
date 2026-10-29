import { ArrowRight, Check, Flame, HelpCircle, Paintbrush, Share2, Shield, Star } from 'lucide-react'
import { TYPE_COLOURS, typeKeyFor } from '../components/ios/pokemon'
import { fill } from '../delights/delights'
import {
  dayMonth, monthBars, monthName, signed, startsInYear, thousands, typePercent, valuePoints,
} from './wrapped'

// The ten Wrapped slides (engagement P9b), after the approved mockups (WrappedStory.dc.html). Each
// slide is one full-screen panel; `ctx` carries the data, `t`, a money formatter that already masks
// amounts while hide-values is on, and the locale. Type colours and the app font come from the shell.

const gradient = key => {
  const colours = TYPE_COLOURS[key]
  return `linear-gradient(160deg, ${colours.top}, ${colours.bottom})`
}
const PAD = 'box-border flex h-full flex-col px-7 pb-14 pt-[104px]'
const SCRIM = 'rounded-[18px] bg-black/25 px-4 py-3.5'

function Big({ lead, value, unit }) {
  return (
    <>
      <p className="m-0 text-[20px] font-semibold opacity-90">{lead}</p>
      <p className="m-0 mt-0.5 text-[76px] font-extrabold leading-none tracking-[-2.5px] tabular-nums">{value}</p>
      {unit && <p className="m-0 text-[28px] font-extrabold">{unit}</p>}
    </>
  )
}

function CardArt({ src, name, tilt = 0, width = 190 }) {
  return (
    <img
      src={src}
      alt={name}
      width={width}
      height={Math.round(width * 7 / 5)}
      className="rounded-xl bg-black/25 object-cover shadow-[0_18px_40px_rgba(0,0,0,0.4)]"
      style={{ width, height: Math.round(width * 7 / 5), transform: `rotate(${tilt}deg)` }}
    />
  )
}

function Cover({ ctx: { data, t, name, locale } }) {
  return (
    <div className={`${PAD} relative overflow-hidden bg-black`}>
      <div aria-hidden="true" className="pointer-events-none absolute -left-20 -top-[60px] h-[460px] w-[560px]"
        style={{ background: 'radial-gradient(closest-side, rgba(227,53,13,0.55), rgba(138,59,165,0.25) 55%, transparent)' }} />
      <div aria-hidden="true" className="pointer-events-none absolute -right-[110px] bottom-[90px] h-[320px] w-[320px] rounded-full border-[34px] border-white/10" />
      {name && <p className="relative m-0 text-[22px] font-bold text-[#FFB199]">{fill(t('wrapped.owner'), { name })}</p>}
      <h1 className="relative m-0 mt-1 text-[64px] font-extrabold leading-[0.95] tracking-[-2px]">
        {data.year}<br />{t('wrapped.inCards')}
      </h1>
      {startsInYear(data) && (
        <p className="relative m-0 mt-5 max-w-[290px] text-[17px] leading-snug text-[#D1D1D6]">
          {fill(t('wrapped.sinceStart'), { date: dayMonth(data.history_starts, locale) })}
        </p>
      )}
      <div className="flex-1" />
      <p className="relative m-0 flex items-center gap-2 text-[15px] font-semibold text-[#C7C7CC]">
        {t('wrapped.tapToStart')} <ArrowRight size={16} aria-hidden="true" />
      </p>
    </div>
  )
}

function Cards({ ctx: { data, t, locale } }) {
  const totals = data.totals
  const bars = monthBars(data)
  const biggest = data.biggest_month
  const labels = Array.from({ length: 12 }, (_, i) => monthName(i + 1, locale, 'narrow'))
  return (
    <div className={PAD} style={{ background: gradient('fire') }}>
      <Big lead={t('wrapped.youAdded')} value={thousands(totals.cards, locale)} unit={t(totals.cards === 1 ? 'wrapped.cardOne' : 'wrapped.cards')} />
      <p className="m-0 mt-2.5 text-[17px] opacity-90">
        {fill(t('wrapped.uniqueFromSets'), { unique: thousands(totals.unique_cards, locale), sets: thousands(totals.sets_touched, locale) })}
      </p>
      <div className="flex-1" />
      {bars && (
        <div role="img" aria-label={biggest ? fill(t('wrapped.chartLabel'), { month: monthName(biggest.month, locale), count: biggest.count }) : t('wrapped.chartPlain')}
          className="grid h-[170px] grid-cols-12 items-end gap-1.5">
          {bars.map(bar => (
            <div key={bar.index} className="flex h-full flex-col items-center justify-end gap-1.5">
              <div className="w-full rounded-t-[4px] rounded-b-[2px]"
                style={{ height: `${bar.height}%`, background: bar.top ? '#FFCB05' : 'rgba(255,255,255,0.55)' }} />
              <span aria-hidden="true" className="text-[11px] font-semibold opacity-90">{labels[bar.index]}</span>
            </div>
          ))}
        </div>
      )}
      {biggest && (
        <p className="m-0 mt-[18px] text-[18px] font-bold">
          {fill(t('wrapped.biggestMonth'), { month: monthName(biggest.month, locale), count: thousands(biggest.count, locale) })}
        </p>
      )}
    </div>
  )
}

function First({ ctx: { data, t, locale } }) {
  const card = data.first_card
  const detail = [card.set_name && card.number ? `${card.set_name} ${card.number}` : card.set_name, card.variant].filter(Boolean).join(' · ')
  return (
    <div className={`${PAD} items-center text-center`} style={{ background: gradient('grass') }}>
      <p className="m-0 text-[22px] font-bold">{fill(t('wrapped.firstCard'), { year: data.year })}</p>
      <div className="mt-9"><CardArt src={card.image} name={card.name} tilt={-3} /></div>
      <p className="m-0 mt-10 text-[30px] font-extrabold">{card.name}</p>
      {detail && <p className="m-0 mt-1 text-[17px] opacity-90">{detail}</p>}
      {card.acquired_on && <p className="m-0 mt-1 text-[17px] opacity-90">{fill(t('wrapped.added'), { date: dayMonth(card.acquired_on, locale) })}</p>}
    </div>
  )
}

function Pull({ ctx: { data, t, locale, money } }) {
  const card = data.best_pull
  const detail = [card.set_name && card.number ? `${card.set_name} ${card.number}` : card.set_name,
    card.acquired_on && fill(t('wrapped.addedLower'), { date: dayMonth(card.acquired_on, locale) })].filter(Boolean).join(' · ')
  return (
    <div className={`${PAD} items-center text-center`} style={{ background: gradient('lightning'), color: '#1D1600' }}>
      <p className="m-0 text-[22px] font-bold">{t('wrapped.topPull')}</p>
      <div className="mt-[30px]"><CardArt src={card.image} name={card.name} width={210} /></div>
      <p className="m-0 mt-[30px] text-[30px] font-extrabold">{card.name}</p>
      {detail && <p className="m-0 mt-0.5 text-[17px]">{detail}</p>}
      {card.price > 0 && <p data-testid="wrapped-pull-value" className="m-0 mt-3.5 text-[44px] font-extrabold tracking-[-1px]">{money(card.price)}</p>}
    </div>
  )
}

function Favourites({ ctx: { data, t, locale } }) {
  const { top_pokemon: pokemon, top_type: top, top_illustrator: artist } = data
  const key = typeKeyFor(top?.type) || 'psychic'
  const percent = typePercent(data)
  return (
    <div className={PAD} style={{ background: gradient(key === 'colorless' ? 'psychic' : key) }}>
      {pokemon && (
        <>
          <p className="m-0 text-[20px] font-semibold opacity-90">{t('wrapped.pokemonOfYear')}</p>
          <p className="m-0 mt-1 text-[56px] font-extrabold leading-none tracking-[-2px]">{pokemon.name}</p>
          <p className="m-0 mt-1.5 text-[20px] font-bold">{fill(t(pokemon.count === 1 ? 'wrapped.pokemonCardsOne' : 'wrapped.pokemonCards'), { count: thousands(pokemon.count, locale) })}</p>
        </>
      )}
      <div className="flex-1" />
      <div className="flex flex-col gap-3">
        {top && (
          <div className={`${SCRIM} flex items-center gap-3.5`}>
            <div aria-hidden="true" className="grid h-12 w-12 shrink-0 place-items-center rounded-full"
              style={{ background: `conic-gradient(${TYPE_COLOURS[key].solid} 0 ${percent}%, rgba(255,255,255,0.18) ${percent}% 100%)` }}>
              <div className="h-[34px] w-[34px] rounded-full" style={{ background: TYPE_COLOURS[key].bottom }} />
            </div>
            <div>
              <p className="m-0 text-[14px] opacity-85">{t('wrapped.topType')}</p>
              <p className="m-0 mt-0.5 text-[20px] font-extrabold">
                {t(`wrapped.types.${key}`)}{percent > 0 ? ` · ${percent}%` : ''}
              </p>
            </div>
          </div>
        )}
        {artist && (
          <div className={`${SCRIM} flex items-center gap-3.5`}>
            <div aria-hidden="true" className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-white/15"><Paintbrush size={24} /></div>
            <div className="min-w-0">
              <p className="m-0 text-[14px] opacity-85">{t('wrapped.topIllustrator')}</p>
              <p className="m-0 mt-0.5 text-[20px] font-extrabold">{fill(t('wrapped.illustratorCards'), { name: artist.name, count: thousands(artist.count, locale) })}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Sets({ ctx: { data, t, locale } }) {
  const count = data.totals.sets_completed
  const listed = Array.isArray(data.completed_sets) ? data.completed_sets : []
  const shown = listed.slice(0, 3)
  const closest = data.closest_set
  return (
    <div className={PAD} style={{ background: gradient('water') }}>
      {count > 0 ? (
        <Big lead={t('wrapped.youCompleted')} value={thousands(count, locale)} unit={t(count === 1 ? 'wrapped.setOne' : 'wrapped.sets')} />
      ) : (
        <p className="m-0 text-[28px] font-extrabold">{t('wrapped.noSetsYet')}</p>
      )}
      {shown.length > 0 && (
        <ul className="m-0 mt-7 flex list-none flex-col gap-2.5 p-0">
          {shown.map(set => (
            <li key={set.set_id || set.name} className="flex items-center gap-3 text-[18px] font-bold">
              <span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#30D158] text-[#003311]"><Check size={15} strokeWidth={3} /></span>
              {set.name}
            </li>
          ))}
          {listed.length > shown.length && <li className="pl-9 text-[16px] opacity-85">{fill(t('wrapped.andMore'), { count: listed.length - shown.length })}</li>}
        </ul>
      )}
      <div className="flex-1" />
      {closest && (
        <div className={SCRIM}>
          <div className="flex justify-between text-[14px] opacity-90"><span>{t('wrapped.closestToDone')}</span><span className="tabular-nums">{closest.owned} / {closest.total}</span></div>
          <p className="m-0 mb-2 mt-0.5 text-[20px] font-extrabold">{fill(t('wrapped.closestLine'), { set: closest.name, missing: closest.missing })}</p>
          <div className="h-2 overflow-hidden rounded-full bg-white/20">
            <div className="h-full rounded-full bg-[#30D158]" style={{ width: `${Math.min(100, Math.round((closest.owned / Math.max(1, closest.total)) * 100))}%` }} />
          </div>
        </div>
      )}
    </div>
  )
}

function Value({ ctx: { data, t, locale, money } }) {
  const { value } = data
  const points = valuePoints(value)
  const W = 334
  const H = 190
  const coords = points.map(p => [Math.round(p.x * W), Math.round(8 + (1 - p.y) * (H - 40))])
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ')
  const peak = points.reduce((best, p, i) => (p.y > points[best].y ? i : best), 0)
  const change = value.end - value.start
  const peakMonth = value.peak_date ? monthName(Number(String(value.peak_date).split('-')[1]), locale) : ''
  const since = startsInYear(data)
    ? fill(t('wrapped.sinceMonth'), { month: monthName(Number(String(data.history_starts).split('-')[1]), locale) })
    : t('wrapped.thisYear')
  return (
    <div className={`${PAD} relative overflow-hidden bg-[#101012]`}>
      <div aria-hidden="true" className="pointer-events-none absolute -left-10 bottom-[60px] h-[340px] w-[470px]"
        style={{ background: 'radial-gradient(closest-side, rgba(48,209,88,0.28), transparent)' }} />
      <p className="relative m-0 text-[20px] font-semibold text-[#C7C7CC]">{t('wrapped.worth')}</p>
      <p data-testid="wrapped-value" className="relative m-0 mt-0.5 text-[64px] font-extrabold leading-none tracking-[-2.5px]">{money(value.end)}</p>
      {change !== 0 && (
        <p className={`relative m-0 mt-2 text-[20px] font-bold ${change > 0 ? 'text-[#30D158]' : 'text-[#FF9F0A]'}`}>
          {signed(change, money(Math.abs(change)))} {since}
        </p>
      )}
      <div className="flex-1" />
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('wrapped.valueChart')} className="relative">
        <path d={`${line} L${W} ${H} L0 ${H} Z`} fill="rgba(48,209,88,0.16)" />
        <path d={line} fill="none" stroke="#30D158" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={coords[peak][0]} cy={coords[peak][1]} r="7" fill="#FFCB05" stroke="#101012" strokeWidth="3" />
      </svg>
      <p className="relative m-0 mt-4 text-[17px]">
        <span className="font-bold text-[#FFCB05]">{fill(t('wrapped.peak'), { amount: money(value.peak) })}</span>
        {peakMonth && <span className="text-[#C7C7CC]"> {fill(t('wrapped.peakIn'), { month: peakMonth })}</span>}
      </p>
    </div>
  )
}

function Tile({ icon, value, label }) {
  return (
    <div className="box-border min-h-[120px] rounded-[20px] bg-black/25 p-4">
      {icon}
      <dd className="m-0 mt-1.5 text-[32px] font-extrabold tabular-nums">{value}</dd>
      <dt className="text-[14px] opacity-90">{label}</dt>
    </div>
  )
}

function Streak({ ctx: { data, t, locale } }) {
  const days = data.longest_streak
  return (
    <div className={PAD} style={{ background: 'linear-gradient(160deg, #D9541E, #7A1E0E)' }}>
      <p className="m-0 text-[20px] font-semibold opacity-90">{t('wrapped.keptComingBack')}</p>
      <p className="m-0 mt-0.5 text-[44px] font-extrabold leading-[1.05] tracking-[-1px]">{t('wrapped.everyDay')}</p>
      <div className="flex-1" />
      <dl className="m-0 grid grid-cols-2 gap-3">
        {days > 0 && <Tile icon={<Flame size={28} fill="#FFB199" stroke="none" aria-hidden="true" />} value={fill(t(days === 1 ? 'wrapped.dayOne' : 'wrapped.days'), { count: days })} label={t('wrapped.longestStreak')} />}
        {data.wtp_wins > 0 && <Tile icon={<HelpCircle size={28} aria-hidden="true" />} value={thousands(data.wtp_wins, locale)} label={t('wrapped.wtpWins')} />}
        {data.quests_done > 0 && <Tile icon={<Check size={28} aria-hidden="true" />} value={thousands(data.quests_done, locale)} label={t('wrapped.questsDone')} />}
        {data.level > 0 && <Tile icon={<Shield size={28} fill="#FFCB05" stroke="none" aria-hidden="true" />} value={fill(t('wrapped.level'), { level: data.level })} label={data.xp_year > 0 ? fill(t('wrapped.xpYear'), { xp: thousands(data.xp_year, locale) }) : t('wrapped.trainerLevel')} />}
      </dl>
    </div>
  )
}

function Badges({ ctx: { data, t, locale } }) {
  const { badges_earned: badges, trades, products } = data
  const stats = [
    trades?.count > 0 && { value: thousands(trades.count, locale), label: t(trades.count === 1 ? 'wrapped.tradeOne' : 'wrapped.trades') },
    products?.count > 0 && { value: thousands(products.count, locale), label: t('wrapped.productsOpened') },
    data.level > 0 && { value: fill(t('wrapped.levelShort'), { level: data.level }), label: t('wrapped.trainerLevel') },
  ].filter(Boolean)
  return (
    <div className={PAD} style={{ background: gradient('darkness') }}>
      {badges > 0 ? (
        <>
          <Big lead={t('wrapped.youEarned')} value={thousands(badges, locale)} unit={t(badges === 1 ? 'wrapped.badgeOne' : 'wrapped.badges')} />
          <div aria-hidden="true" className="mt-8 grid h-[84px] w-[84px] place-items-center rounded-full"
            style={{ background: 'linear-gradient(180deg, #FFE56E, #F2A600)' }}><Star size={38} fill="#1D1600" stroke="none" /></div>
        </>
      ) : (
        <p className="m-0 text-[28px] font-extrabold">{t('wrapped.alsoThisYear')}</p>
      )}
      <div className="flex-1" />
      {stats.length > 0 && (
        <dl className="m-0 flex justify-around rounded-[18px] bg-black/30 px-4 py-3.5 text-center">
          {stats.map(stat => (
            <div key={stat.label}><dd className="m-0 text-[28px] font-extrabold tabular-nums">{stat.value}</dd><dt className="text-[14px] opacity-90">{stat.label}</dt></div>
          ))}
        </dl>
      )}
    </div>
  )
}

function Summary({ ctx: { data, t, locale, name, money, showDaily, onShare, onPrepare, onRestart } }) {
  const pull = data.best_pull
  const stats = [
    [t('wrapped.cardsAdded'), thousands(data.totals.cards, locale)],
    [t('wrapped.setsCompleted'), thousands(data.totals.sets_completed, locale)],
    data.top_pokemon && [t('wrapped.pokemonOfYear'), data.top_pokemon.name],
    showDaily && data.longest_streak > 0 && [t('wrapped.longestStreak'), fill(t(data.longest_streak === 1 ? 'wrapped.dayOne' : 'wrapped.days'), { count: data.longest_streak })],
  ].filter(Boolean)
  return (
    <div className="relative box-border flex h-full flex-col overflow-hidden bg-black px-6 pb-10 pt-24">
      <div aria-hidden="true" className="pointer-events-none absolute -right-[90px] -top-10 h-[420px] w-[460px]"
        style={{ background: 'radial-gradient(closest-side, rgba(47,143,240,0.4), rgba(138,59,165,0.2) 60%, transparent)' }} />
      <div className="relative rounded-[26px] p-0.5" style={{ background: 'linear-gradient(135deg, #E3350D, #8A3BA5 50%, #236BB4)' }}>
        <div className="rounded-3xl bg-[#121214] p-5">
          <p className="m-0 text-[14px] font-bold uppercase tracking-[1.2px] text-[#FFB199]">
            {name ? fill(t('wrapped.ownerYear'), { name, year: data.year }) : data.year}
          </p>
          {pull && (
            <div className="mt-3.5 flex items-center gap-4">
              <img src={pull.image} alt="" width="76" height="106" className="h-[106px] w-[76px] shrink-0 rounded-lg bg-black/30 object-cover shadow-[0_8px_20px_rgba(0,0,0,0.5)]" />
              <div className="min-w-0">
                <p className="m-0 text-[13px] text-[#A1A1A6]">{t('wrapped.topPull')}</p>
                <p className="m-0 mt-px truncate text-[20px] font-extrabold">{pull.name}</p>
                {pull.price > 0 && <p className="m-0 mt-px text-[18px] font-bold text-[#FFCB05]">{money(pull.price)}</p>}
              </div>
            </div>
          )}
          <dl className="m-0 mt-[18px] grid grid-cols-2 gap-x-3 gap-y-3.5">
            {stats.map(([label, value]) => (
              <div key={label}><dt className="text-[13px] text-[#A1A1A6]">{label}</dt><dd className="m-0 mt-px truncate text-[22px] font-extrabold">{value}</dd></div>
            ))}
          </dl>
        </div>
      </div>
      <div className="flex-1" />
      <div className="relative z-[3] flex flex-col gap-2.5">
        <button type="button" onPointerDown={onPrepare} onClick={onShare} data-testid="wrapped-share"
          className="flex min-h-[52px] items-center justify-center gap-2 rounded-full bg-white text-[17px] font-bold text-[#1C1C1E]">
          <Share2 size={20} aria-hidden="true" />{t('wrapped.sharePicture')}
        </button>
        <button type="button" onClick={onRestart} data-testid="wrapped-restart"
          className="min-h-[48px] rounded-full bg-white/15 text-[16px] font-semibold text-white">{t('wrapped.watchAgain')}</button>
      </div>
    </div>
  )
}

const SLIDES = {
  cover: Cover, cards: Cards, first: First, pull: Pull, favourites: Favourites,
  sets: Sets, value: Value, streak: Streak, badges: Badges, summary: Summary,
}

export default function Slide({ id, ctx }) {
  const Component = SLIDES[id]
  return Component ? <Component ctx={ctx} /> : null
}
