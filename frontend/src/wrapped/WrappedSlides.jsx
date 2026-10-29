import { fill } from '../delights/delights'
import {
  BadgeCase, CardBack, CardImage, DISP, FitLine, FoilCoin, HeroNumber, HoloCard, SetMark, SlideFrame, Sparkle,
  TrainerCard, TypeCoin, TypeGlyph, largeImage,
} from './pieces'
import { BOLT, CHECK, DARK_INK, DROP, FLAME, HEX, SHARE, SHIELD, paletteFor } from './theme'
import { trainerCardLabel, trainerCardModel } from './trainerCard'
import {
  dayMonth, monthCells, monthName, pad3, personaKey, signed, startMonth, startsInYear, thousands, topTypeKey,
  typePercent, valueChart, weeksAndDays,
} from './wrapped'

// The ten Wrapped v2 slides (engagement P9c), ported from the Wave 2b mockups (W2bCover … W2bSummary,
// and W2bThinData for a new trainer). Positions are the mockups' own, in a 390 × 844 stage that
// WrappedStory scales to the screen. `ctx` carries the data, `t`, the locale, `money` (which masks
// every amount while hide-values is on), and `n` / `total` for the collector pill.

const abs = style => ({ position: 'absolute', ...style })
const px = n => `${n}px`
const glow = (left, top, width, height, colour) => (
  <div aria-hidden="true" style={abs({ left, top, width, height, background: `radial-gradient(closest-side, ${colour}, transparent)` })} />
)
const burst = (left, top, width, height, colour, on, off, stop) => (
  <div aria-hidden="true" className="wp-burst" style={abs({
    left, top, width, height,
    background: `repeating-conic-gradient(from 0deg at 50% 50%, ${colour} 0deg ${on}deg, transparent ${on}deg ${off}deg)`,
    WebkitMaskImage: `radial-gradient(closest-side, #000 ${stop}%, transparent)`,
    maskImage: `radial-gradient(closest-side, #000 ${stop}%, transparent)`,
  })} />
)
const watermark = (path, left, top, size, opacity) => (
  <svg aria-hidden="true" style={abs({ left, top, opacity })} width={size} height={size} viewBox="0 0 24 24"><path d={path} fill="#FFFFFF" /></svg>
)
const icon = (path, size, colour) => <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24"><path d={path} fill={colour} /></svg>
const strokeIcon = (paths, size, colour, width) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={colour} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
    {paths.map(d => <path key={d} d={d} />)}
  </svg>
)
const hexAlpha = (hex, alpha) => {
  const n = Number.parseInt(hex.slice(1), 16)
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`
}
const pill = (ctx, id, coin, glyph, background) => ({ n: ctx.n, total: ctx.total, name: ctx.t(`wrapped.pill.${id}`), coin, glyph, background })
const lines = text => String(text).split('\n').map((line, i, all) => (
  <span key={line}>{line}{i < all.length - 1 && <br />}</span>
))
const cardLine = card => [card.set_name, card.number].filter(Boolean).join(' · ')
const chip = { padding: '7px 12px', borderRadius: 16, background: 'rgba(0,0,0,0.25)', fontSize: 15, fontWeight: 700 }

// ── 001 Cover ──────────────────────────────────────────────────────────────
const FAN_BACK = {
  position: 'absolute', left: '50%', top: 20, marginLeft: -75, transformOrigin: '50% 100%',
  boxShadow: '0 18px 40px rgba(0,0,0,0.55)', borderRadius: 12,
}

function Cover({ ctx: { data, t, name, locale } }) {
  const since = startsInYear(data)
  return (
    <SlideFrame
      background="radial-gradient(120% 70% at 50% 48%, #2B2160 0%, #121433 55%, #08091A 100%)"
      texture={0.045}
      decor={<>
        {glow(-120, -80, 460, 420, 'rgba(227,53,13,0.45)')}
        {glow(70, 420, 460, 420, 'rgba(42,117,187,0.5)')}
      </>}
      pill={{ text: t('wrapped.brand'), coin: 'linear-gradient(135deg, #FFE56E, #FF9BD2, #9BE7FF)', glyph: <Sparkle size={12} fill={DARK_INK} />, background: 'rgba(255,255,255,0.12)' }}
    >
      <div style={abs({ left: 24, right: 24, top: 160, textAlign: 'center' })}>
        <p style={{ margin: 0, fontSize: 24, fontWeight: 800, color: '#FFC9B8' }}>{fill(t('wrapped.owner'), { name: name || t('wrapped.trainer') })}</p>
        <HeroNumber text={String(data.year)} size={172} spacing={-4} style={{ margin: '2px 0 0' }}
          gradient="linear-gradient(100deg, #FFFFFF 8%, #FFE56E 32%, #FF9BD2 54%, #9BE7FF 76%, #FFFFFF 96%)" />
        <p style={{ margin: '10px 0 0', ...DISP, fontWeight: 800, fontSize: 30, letterSpacing: 0.5 }}>{t('wrapped.yearInCards')}</p>
      </div>
      <div aria-hidden="true" className="wp-fan" style={abs({ left: 0, right: 0, top: 400, height: 270 })}>
        <div style={{ ...FAN_BACK, transform: 'translateX(-78px) rotate(-15deg)' }}><CardBack width={150} height={210} radius={12} border={5} /></div>
        <div style={{ ...FAN_BACK, transform: 'translateX(78px) rotate(15deg)' }}><CardBack width={150} height={210} radius={12} border={5} /></div>
        <div style={abs({ left: '50%', top: 0, marginLeft: -82, borderRadius: 13, boxShadow: '0 22px 50px rgba(0,0,0,0.6)' })}>
          <CardBack width={164} height={230} radius={13} border={5} front />
        </div>
        <div style={abs({ left: 149, top: 186 })}><SetMark year={data.year} /></div>
        <Sparkle size={22} style={abs({ left: 44, top: 6 })} />
        <Sparkle size={16} fill="#FFE56E" style={abs({ left: 334, top: 60 })} />
        <Sparkle size={12} fill="#9BE7FF" style={abs({ left: 308, top: 200 })} />
      </div>
      <div style={abs({ left: 24, right: 24, top: 694, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 })}>
        <p style={{
          margin: 0, padding: '6px 14px', borderRadius: 10, border: '1.5px dashed rgba(255,255,255,0.6)', fontSize: 15, fontWeight: 600,
          color: '#E5E5EA', visibility: since ? 'visible' : 'hidden',
        }}>{fill(t('wrapped.collectedSince'), { date: since ? dayMonth(data.history_starts, locale) : '' })}</p>
        <span aria-hidden="true" style={{
          minHeight: 50, padding: '0 26px', borderRadius: 25, background: '#FFFFFF', color: '#121433', fontSize: 17, fontWeight: 800,
          display: 'flex', alignItems: 'center', gap: 8, boxSizing: 'border-box',
        }}>{t('wrapped.tapToOpen')} {strokeIcon(['M5 12h14M13 6l6 6-6 6'], 18, 'currentColor', 2.6)}</span>
      </div>
    </SlideFrame>
  )
}

// ── 002 Cards ──────────────────────────────────────────────────────────────
function MonthChart({ ctx: { data, t, locale } }) {
  const chart = monthCells(data)
  if (!chart) return null
  const biggest = data.biggest_month
  const labels = Array.from({ length: 12 }, (_, i) => monthName(i + 1, locale, 'narrow'))
  const from = startMonth(data)
  const label = [
    biggest ? fill(t('wrapped.chartLabel'), { month: monthName(biggest.month, locale), count: thousands(biggest.count, locale) }) : t('wrapped.chartPlain'),
    from > 1 ? fill(t('wrapped.chartUntracked'), { month: monthName(from, locale) }) : '',
  ].filter(Boolean).join(' ')
  return (
    <div role="img" aria-label={label} style={{
      flex: 1, minHeight: 0, borderRadius: 24, background: 'rgba(0,0,0,0.24)', padding: '16px 14px 12px', boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: '#FFE5DC' }}>{t('wrapped.cardsEachMonth')}</span>
        {biggest && (
          <span style={{ padding: '4px 10px', borderRadius: 12, background: '#FFCB05', color: DARK_INK, fontSize: 14, fontWeight: 800 }}>
            {monthName(biggest.month, locale)} · {thousands(biggest.count, locale)}
          </span>
        )}
      </div>
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 5, alignItems: 'end' }}>
        {chart.cells.map(cell => (
          <div key={cell.index} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: 6, height: '100%' }}>
            {chart.few && !cell.untracked ? (
              <div style={{ display: 'flex', flexDirection: 'column-reverse', gap: 4, alignItems: 'center' }}>
                {Array.from({ length: cell.count }, (_, k) => (
                  <span key={k} className="wp-pop" style={{
                    width: 18, height: 18, borderRadius: 9, animationDelay: `${(cell.index * 3 + k) * 30}ms`,
                    background: cell.top ? 'radial-gradient(circle at 40% 35%, #FFFFFF, #FFE56E)' : 'rgba(255,255,255,0.72)',
                    boxShadow: cell.top ? '0 0 12px rgba(255,203,5,0.7)' : 'none',
                  }} />
                ))}
              </div>
            ) : (
              <div className={cell.untracked ? undefined : 'wp-grow'} style={{
                width: '100%', boxSizing: 'border-box', borderRadius: '6px 6px 3px 3px',
                height: cell.untracked ? 36 : Math.max(4, Math.round(cell.ratio * 250)),
                background: cell.untracked ? 'transparent' : cell.top ? 'linear-gradient(180deg, #FFE56E, #FFCB05)' : 'rgba(255,255,255,0.72)',
                border: cell.untracked ? '2px dashed rgba(255,255,255,0.55)' : 0,
                boxShadow: cell.top ? '0 0 22px rgba(255,203,5,0.7)' : 'none',
                animationDelay: `${cell.index * 35}ms`,
              }} />
            )}
            <span aria-hidden="true" style={{ fontSize: 12, fontWeight: 700, color: cell.untracked ? 'rgba(255,255,255,0.8)' : cell.top ? '#FFE56E' : '#FFFFFF' }}>{labels[cell.index]}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Cards({ ctx }) {
  const { data, t, locale } = ctx
  const totals = data.totals
  const unit = t(totals.cards === 1 ? 'wrapped.cardOne' : 'wrapped.cards')
  return (
    <SlideFrame
      background="linear-gradient(160deg, #B4441F, #8A1D12)"
      decor={<>
        {glow(-80, 120, 480, 360, 'rgba(240,90,43,0.45)')}
        {watermark(FLAME, 160, 150, 300, 0.09)}
      </>}
      pill={pill(ctx, 'cards', '#F05A2B', icon(FLAME, 13, '#FFFFFF'))}
    >
      <div style={abs({ left: 20, right: 20, top: 158, bottom: 48, display: 'flex', flexDirection: 'column', gap: 12 })}>
        <p style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{t('wrapped.youAdded')}</p>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
          <HeroNumber count={totals.cards} locale={locale} size={178} spacing={-5} maxWidth={350 - 10 - unit.length * 21}
            gradient="linear-gradient(100deg, #FFFFFF 15%, #FFF2C2 40%, #FFD1E8 60%, #FFFFFF 85%)" />
          <p style={{ margin: '0 0 6px', ...DISP, fontSize: 44, lineHeight: 1 }}>{unit}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {totals.unique_cards > 0 && <span style={chip}>{fill(t('wrapped.unique'), { count: thousands(totals.unique_cards, locale) })}</span>}
          {totals.sets_touched > 0 && <span style={chip}>{fill(t(totals.sets_touched === 1 ? 'wrapped.fromSetOne' : 'wrapped.fromSets'), { count: thousands(totals.sets_touched, locale) })}</span>}
        </div>
        <MonthChart ctx={ctx} />
      </div>
    </SlideFrame>
  )
}

// ── 003 First card ─────────────────────────────────────────────────────────
function First({ ctx }) {
  const { data, t, locale } = ctx
  const card = data.first_card
  return (
    <SlideFrame
      background="linear-gradient(160deg, #2E7A34, #145A27)"
      decor={<>
        {burst(-170, 140, 730, 600, 'rgba(255,255,255,0.13)', 7, 20, 30)}
        {glow(-40, 230, 470, 420, 'rgba(67,176,74,0.55)')}
      </>}
      pill={pill(ctx, 'first', '#43B04A', strokeIcon(['M5 19c0-9 6-14 15-14 0 9-5 15-14 15M5 19l8-8'], 13, '#FFFFFF', 2.6))}
    >
      <div style={abs({ left: 20, right: 20, top: 160, textAlign: 'center' })}>
        <p style={{ margin: 0, ...DISP, fontSize: 46, lineHeight: 0.95, letterSpacing: -0.5 }}>{lines(fill(t('wrapped.firstCardTitle'), { year: data.year }))}</p>
      </div>
      <div className="wp-pop" style={abs({ left: 77, top: 278, width: 236, height: 330 })}>
      <div style={{ position: 'relative', width: 236, height: 330, transform: 'rotate(-4deg)' }}>
        <div style={{ borderRadius: 14, boxShadow: '0 24px 50px rgba(0,0,0,0.45)' }}>
          <CardImage src={largeImage(card.image)} name={card.name} width={236} height={330} radius={14} />
        </div>
        <div aria-hidden="true" style={abs({
          right: -26, top: -22, width: 68, height: 68, borderRadius: 34, background: '#FFCB05', color: DARK_INK, display: 'flex',
          flexDirection: 'column', alignItems: 'center', justifyContent: 'center', transform: 'rotate(14deg)', boxShadow: '0 8px 20px rgba(0,0,0,0.35)',
          border: '3px dashed rgba(29,22,0,0.45)', boxSizing: 'border-box',
        })}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1 }}>{t('wrapped.numberShort')}</span>
          <span style={{ ...DISP, fontSize: 26, lineHeight: 0.9 }}>001</span>
        </div>
      </div>
      </div>
      <div style={abs({ left: 20, right: 20, top: 636, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, textAlign: 'center' })}>
        <FitLine text={card.name} size={50} maxWidth={350} />
        {cardLine(card) && <p style={{ margin: 0, fontSize: 17, fontWeight: 600, color: '#E8F5E9' }}>{cardLine(card)}</p>}
        {card.acquired_on && <p style={{ margin: '6px 0 0', ...chip, padding: '7px 14px' }}>{fill(t('wrapped.added'), { date: dayMonth(card.acquired_on, locale) })}</p>}
      </div>
    </SlideFrame>
  )
}

// ── 004 Top pull ───────────────────────────────────────────────────────────
function Pull({ ctx }) {
  const { data, t, locale, money } = ctx
  const card = data.best_pull
  const detail = [
    [card.set_name, card.number].filter(Boolean).join(' '),
    card.acquired_on && fill(t('wrapped.addedLower'), { date: dayMonth(card.acquired_on, locale) }),
  ].filter(Boolean).join(' · ')
  return (
    <SlideFrame
      background="linear-gradient(160deg, #FFE56E, #F2A600)"
      texture={0}
      ink={DARK_INK}
      decor={<>
        {burst(-200, 90, 790, 680, 'rgba(255,255,255,0.5)', 6, 18, 25)}
        {glow(-10, 250, 410, 380, 'rgba(255,255,255,0.75)')}
      </>}
      pill={pill(ctx, 'pull', DARK_INK, icon(BOLT, 13, '#FFCB05'), 'rgba(29,22,0,0.12)')}
    >
      <p style={abs({ left: 20, right: 20, top: 160, margin: 0, textAlign: 'center', ...DISP, fontSize: 52, lineHeight: 1, letterSpacing: -0.5 })}>{t('wrapped.topPull')}</p>
      <div className="wp-flip" style={abs({ left: 62, top: 236, width: 266, height: 370 })}>
        <HoloCard src={largeImage(card.image)} name={card.name} width={266} height={370} shadow="0 28px 60px rgba(90,60,0,0.45)" />
        {card.price > 0 && (
          <div style={abs({
            left: '50%', bottom: -30, transform: 'translateX(-50%)', padding: '8px 22px 6px', borderRadius: 16, background: DARK_INK,
            color: '#FFCB05', boxShadow: '0 10px 24px rgba(60,40,0,0.4)', whiteSpace: 'nowrap',
          })}>
            <span data-testid="wrapped-pull-value" style={{ ...DISP, fontSize: 42, lineHeight: 1 }}>{money(card.price)}</span>
          </div>
        )}
        <Sparkle size={30} style={abs({ left: -38, top: 30 })} />
        <Sparkle size={22} fill={DARK_INK} style={abs({ left: 284, top: 120 })} />
        <Sparkle size={34} style={abs({ left: 262, top: -14 })} />
        <Sparkle size={16} fill={DARK_INK} style={abs({ left: -28, top: 280 })} />
      </div>
      <div style={abs({ left: 20, right: 20, top: 660, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, textAlign: 'center' })}>
        <FitLine text={card.name} size={46} maxWidth={350} />
        {detail && <p style={{ margin: 0, fontSize: 17, fontWeight: 600, color: '#3A2E00' }}>{detail}</p>}
      </div>
    </SlideFrame>
  )
}

// ── 005 Favourites / trainer type ──────────────────────────────────────────
const BRUSH = ['M18.4 2.6a2 2 0 0 1 2.9 2.9L11 15.8 8.2 13z', 'M7.2 14.2c-2 0-3.6 1.6-3.6 3.6 0 1.2-.8 2.2-2 2.6 1 .9 2.5 1.4 4 1.4a4.4 4.4 0 0 0 4.4-4.4']

function FavouriteTile({ iconEl, label, children, palette, light }) {
  return (
    <div style={{
      minHeight: 176, borderRadius: 22, background: light ? 'rgba(29,22,0,0.12)' : 'rgba(0,0,0,0.26)', padding: 16, boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0,
    }}>
      {iconEl}
      <dt style={{ fontSize: 14, fontWeight: 600, color: palette.soft, marginTop: 4 }}>{label}</dt>
      {children}
    </div>
  )
}

function Favourites({ ctx }) {
  const { data, t, locale } = ctx
  const { top_pokemon: pokemon, top_illustrator: artist } = data
  const persona = personaKey(data)
  const key = persona || topTypeKey(data) || 'psychic'
  const palette = paletteFor(key)
  const light = palette.ink === DARK_INK
  const accent = light ? DARK_INK : '#FFE56E'
  const percent = typePercent(data)
  const foil = light ? null : `linear-gradient(100deg, #FFFFFF 15%, ${palette.light} 40%, #C9F1FF 60%, #FFFFFF 85%)`
  const countLine = item => fill(t(item.count === 1 ? 'wrapped.pokemonCardsOne' : 'wrapped.pokemonCards'), { count: thousands(item.count, locale) })
  const pokemonTile = pokemon && (
    <FavouriteTile key="pokemon" palette={palette} light={light} label={t('wrapped.pokemonOfTheYear')} iconEl={<Sparkle size={26} fill={accent} />}>
      <dd style={{ margin: 0 }}><FitLine as="span" text={pokemon.name} size={44} maxWidth={persona && artist ? 138 : 318} style={{ display: 'block' }} /></dd>
      <dd style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{countLine(pokemon)}</dd>
    </FavouriteTile>
  )
  const artistTile = artist && (
    <FavouriteTile key="artist" palette={palette} light={light} label={t('wrapped.topIllustrator')} iconEl={strokeIcon(BRUSH, 26, accent, 2)}>
      <dd style={{ margin: 0, fontSize: 21, fontWeight: 800, lineHeight: 1.15 }}>{artist.name}</dd>
      <dd style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{countLine(artist)}</dd>
    </FavouriteTile>
  )
  // Without a persona the first favourite that exists becomes the hero (§6); the other stays a tile.
  const hero = persona ? null : (pokemon ? 'pokemon' : 'artist')
  const heroItem = hero === 'pokemon' ? pokemon : artist
  const tiles = persona ? [pokemonTile, artistTile].filter(Boolean) : (hero === 'pokemon' && artistTile ? [artistTile] : [])
  return (
    <SlideFrame
      background={`linear-gradient(160deg, ${palette.bg[0]}, ${palette.bg[1]})`}
      ink={palette.ink}
      decor={glow(-60, 260, 510, 420, palette.glow)}
      pill={pill(ctx, persona ? 'trainerType' : 'favourites', palette.solid, <TypeGlyph type={key} size={14} color={palette.ink} />)}
    >
      <div style={abs({ left: 20, right: 20, top: 160, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' })}>
        <p style={{ margin: 0, fontSize: 20, fontWeight: 700, color: palette.soft }}>
          {t(persona ? 'wrapped.yourTrainerType' : hero === 'pokemon' ? 'wrapped.pokemonOfYear' : 'wrapped.yourTopIllustrator')}
        </p>
        <HeroNumber text={persona ? t(`wrapped.personas.${persona}`) : heroItem.name} size={92} lineHeight={0.88} spacing={-1}
          maxWidth={350} gradient={foil} style={{ margin: '4px 0 0' }} />
        <p style={{ margin: '8px 0 0', fontSize: 17, fontWeight: 600, color: palette.soft }}>
          {persona ? t(`wrapped.personaLines.${persona}`) : countLine(heroItem)}
        </p>
      </div>
      <div style={abs({ left: 75, top: 336 })} className="wp-pop">
        {persona ? (
          <TypeCoin palette={palette} type={key} percent={percent}
            label={fill(t('wrapped.typeCoinLabel'), { type: t(`wrapped.types.${key}`), percent })}>
            <span style={{ ...DISP, fontSize: 52, lineHeight: 0.95 }}>{percent}%</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: palette.soft }}>{fill(t('wrapped.typeCards'), { type: t(`wrapped.types.${key}`) })}</span>
          </TypeCoin>
        ) : (
          <TypeCoin palette={palette} percent={100} label={countLine(heroItem)}>
            <Sparkle size={40} fill={accent} />
            <span style={{ ...DISP, fontSize: 64, lineHeight: 0.95 }}>{thousands(heroItem.count, locale)}</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: palette.soft }}>{t(heroItem.count === 1 ? 'wrapped.cardOne' : 'wrapped.cards')}</span>
          </TypeCoin>
        )}
      </div>
      <Sparkle size={22} style={abs({ left: 52, top: 340 })} fill={light ? '#FFFFFF' : '#FFFFFF'} />
      <Sparkle size={16} fill="#C9F1FF" style={abs({ left: 324, top: 540 })} />
      {tiles.length > 0 && (
        <dl style={abs({ left: 20, right: 20, top: 604, margin: 0, display: 'grid', gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))`, gap: 10 })}>
          {tiles}
        </dl>
      )}
    </SlideFrame>
  )
}

// ── 006 Sets ───────────────────────────────────────────────────────────────
const TILTS = [-8, 5, -3, 7, -6, 4]

function Seal({ children, tilt, dashed = true }) {
  return (
    <span aria-hidden="true" style={{
      width: 72, height: 72, borderRadius: 36, border: dashed ? '2px dashed rgba(255,255,255,0.7)' : 0, padding: 4, boxSizing: 'border-box',
      transform: `rotate(${tilt}deg)`, display: 'block',
    }}>
      {children}
    </span>
  )
}

function ClosestRing({ closest, size = 88, ring = 9, fontSize = 26, background = '#133F7E' }) {
  const percent = Math.min(100, Math.round((closest.owned / Math.max(1, closest.total)) * 100))
  return (
    <div role="img" aria-label={`${closest.owned} / ${closest.total}, ${percent}%`} style={{
      width: size, height: size, flexShrink: 0, borderRadius: size / 2, padding: ring, boxSizing: 'border-box',
      background: `conic-gradient(#7CF0A0 0 ${percent}%, rgba(255,255,255,0.18) ${percent}% 100%)`,
    }}>
      <div style={{ width: '100%', height: '100%', borderRadius: '50%', background, display: 'grid', placeItems: 'center' }}>
        <span style={{ ...DISP, fontSize }}>{percent}%</span>
      </div>
    </div>
  )
}

function ClosestBar({ closest, t, locale }) {
  const percent = Math.min(100, Math.round((closest.owned / Math.max(1, closest.total)) * 100))
  return (
    <div>
      <div style={{ height: 10, borderRadius: 5, background: 'rgba(255,255,255,0.2)', overflow: 'hidden' }}>
        <div className="wp-grow-x" style={{ width: `${percent}%`, height: '100%', borderRadius: 5, background: 'linear-gradient(90deg, #30D158, #7CF0A0)' }} />
      </div>
      <p style={{ margin: '6px 0 0', fontSize: 14, fontWeight: 600, color: '#DCEBFF', textAlign: 'right' }}>
        {fill(t('wrapped.ofCards'), { owned: thousands(closest.owned, locale), total: thousands(closest.total, locale) })}
      </p>
    </div>
  )
}

function Sets({ ctx }) {
  const { data, t, locale } = ctx
  const count = data.totals.sets_completed
  const listed = Array.isArray(data.completed_sets) ? data.completed_sets : []
  const names = listed.length ? listed.map(set => set.name) : Array.from({ length: Math.min(count, 6) }, () => '')
  const overflow = Math.max(count, names.length) > 6
  const seals = overflow ? names.slice(0, 5) : names.slice(0, 6)
  const more = Math.max(count, names.length) - seals.length
  const closest = data.closest_set
  const toGo = closest && fill(t('wrapped.toGo'), { count: thousands(closest.missing, locale) })
  return (
    <SlideFrame
      background="linear-gradient(160deg, #236BB4, #0F3478)"
      decor={<>
        {glow(120, 100, 420, 380, 'rgba(47,143,240,0.6)')}
        {watermark(DROP, 170, 130, 280, 0.1)}
      </>}
      pill={pill(ctx, 'sets', '#2F8FF0', icon(DROP, 13, '#FFFFFF'))}
    >
      {count > 0 ? (
        <>
          <div style={abs({ left: 20, right: 20, top: 158 })}>
            <p style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{t('wrapped.youCompleted')}</p>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginTop: 6 }}>
              <HeroNumber count={count} locale={locale} size={178} spacing={-4} maxWidth={220}
                gradient="linear-gradient(100deg, #FFFFFF 15%, #C9F1FF 45%, #FFFFFF 85%)" />
              <p style={{ margin: '0 0 6px', ...DISP, fontSize: 48, lineHeight: 1 }}>{t(count === 1 ? 'wrapped.setOne' : 'wrapped.sets')}</p>
            </div>
          </div>
          <ul style={abs({
            left: 14, right: 14, top: 362, margin: 0, padding: 0, listStyle: 'none', display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '14px 8px',
          })}>
            {seals.map((name, i) => (
              <li key={`${name}-${i}`} className="wp-pop" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center', animationDelay: `${i * 70}ms` }}>
                <Seal tilt={TILTS[i]}>
                  <span style={{
                    width: '100%', height: '100%', borderRadius: '50%', background: 'radial-gradient(circle at 40% 35%, #5BB0FF, #1A5FB0)',
                    border: '3px solid #FFFFFF', boxSizing: 'border-box', display: 'grid', placeItems: 'center',
                  }}>{strokeIcon([CHECK], 28, '#FFFFFF', 3.2)}</span>
                </Seal>
                <span style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{name}</span>
              </li>
            ))}
            {overflow && (
              <li style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center' }}>
                <Seal tilt={TILTS[5]}>
                  <span style={{ width: '100%', height: '100%', borderRadius: '50%', background: 'rgba(255,255,255,0.16)', display: 'grid', placeItems: 'center', ...DISP, fontSize: 26 }}>+{more}</span>
                </Seal>
                <span style={{ fontSize: 14, fontWeight: 700, lineHeight: 1.2 }}>{fill(t('wrapped.moreSets'), { count: more })}</span>
              </li>
            )}
          </ul>
          {closest && (
            <div style={abs({
              left: 20, right: 20, top: 612, borderRadius: 24, background: 'rgba(0,0,0,0.26)', padding: '16px 18px', boxSizing: 'border-box',
              display: 'flex', flexDirection: 'column', gap: 14,
            })}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <ClosestRing closest={closest} />
                <div style={{ minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#DCEBFF' }}>{t('wrapped.closestToDone')}</p>
                  <FitLine text={closest.name} size={32} maxWidth={210} style={{ marginTop: 2 }} />
                  <p style={{ margin: '4px 0 0', fontSize: 16, fontWeight: 700, color: '#7CF0A0' }}>{toGo}</p>
                </div>
              </div>
              <ClosestBar closest={closest} t={t} locale={locale} />
            </div>
          )}
        </>
      ) : (
        // No completed sets: the closest set's ring is the hero (§6).
        <>
          <div style={abs({ left: 20, right: 20, top: 158 })}>
            <p style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{t('wrapped.closestToDone')}</p>
            <FitLine text={closest.name} size={64} maxWidth={350} style={{ marginTop: 8 }} />
            <p style={{ margin: '10px 0 0', fontSize: 17, fontWeight: 600, color: '#DCEBFF' }}>{t('wrapped.noSetsYet')}</p>
          </div>
          <div className="wp-pop" style={abs({ left: 75, top: 336 })}>
            <ClosestRing closest={closest} size={240} ring={20} fontSize={72} />
          </div>
          <div style={abs({
            left: 20, right: 20, top: 640, borderRadius: 24, background: 'rgba(0,0,0,0.26)', padding: '16px 18px', boxSizing: 'border-box',
            display: 'flex', flexDirection: 'column', gap: 12,
          })}>
            <p style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#7CF0A0' }}>{toGo}</p>
            <ClosestBar closest={closest} t={t} locale={locale} />
          </div>
        </>
      )}
    </SlideFrame>
  )
}

// ── 007 Value ──────────────────────────────────────────────────────────────
function Value({ ctx }) {
  const { data, t, locale, money, hidden } = ctx
  const { value } = data
  const chart = valueChart(value)
  const pts = chart.points
  const peak = pts[chart.peak]
  const end = pts.at(-1)
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ')
  const area = `${line} L${end.x} 286 L${pts[0].x} 286 Z`
  const change = value.end - value.start
  const from = startMonth(data)
  const since = from ? fill(t('wrapped.sinceMonth'), { month: monthName(from, locale) }) : t('wrapped.thisYear')
  const short = m => monthName(m, locale, 'short')
  const peakMonth = value.peak_date ? Number(String(value.peak_date).split('-')[1]) : peak.month
  const startM = value.start_date ? Number(String(value.start_date).split('-')[1]) : chart.first
  const bubbleText = fill(t('wrapped.peakBubble'), { amount: money(value.peak), month: short(peakMonth) })
  const bubbleW = Math.max(110, Math.round(bubbleText.length * 8))
  const bubbleX = Math.min(Math.max(peak.x - 34, bubbleW / 2 + 2), 342 - bubbleW / 2)
  const bubbleY = peak.y - 46 >= 0 ? peak.y - 46 : peak.y + 14
  const up = change >= 0
  const chartLabel = hidden
    ? fill(t('wrapped.valueChartHidden'), { from: monthName(chart.first, locale), to: monthName(chart.last, locale), peak: monthName(peakMonth, locale) })
    : fill(t('wrapped.valueChartLabel'), { start: money(value.start), end: money(value.end), peak: money(value.peak), month: monthName(peakMonth, locale) })
  const tile = (label, amount, gold) => (
    <div style={{ borderRadius: 16, background: gold ? 'rgba(255,203,5,0.12)' : 'rgba(255,255,255,0.07)', padding: '10px 12px', minWidth: 0 }}>
      <dt style={{ fontSize: 13, fontWeight: 600, color: gold ? '#FFE56E' : '#AEB4BA', whiteSpace: 'nowrap' }}>{label}</dt>
      <dd style={{ margin: '2px 0 0', ...DISP, fontSize: 26, color: gold ? '#FFCB05' : undefined, whiteSpace: 'nowrap' }}>{amount}</dd>
    </div>
  )
  return (
    <SlideFrame
      background="linear-gradient(170deg, #12201C, #0A0F12 60%)"
      texture={0.03}
      decor={glow(-60, 360, 510, 400, 'rgba(48,209,88,0.3)')}
      pill={pill(ctx, 'value', '#30D158', icon(HEX, 13, '#0A0F12'), 'rgba(255,255,255,0.1)')}
    >
      <div style={abs({ left: 20, right: 20, top: 158 })}>
        <p style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#D1D5D8' }}>{t('wrapped.worth')}</p>
        <HeroNumber testId="wrapped-value" text={money(value.end)} size={116} lineHeight={0.85} spacing={-3} maxWidth={350}
          gradient="linear-gradient(100deg, #FFFFFF 15%, #C8FFD8 45%, #C9F1FF 65%, #FFFFFF 90%)" style={{ margin: '6px 0 0' }} />
        {change !== 0 && (
          <p style={{
            margin: '12px 0 0', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 15,
            background: up ? 'rgba(48,209,88,0.16)' : 'rgba(255,159,10,0.16)', color: up ? '#5BE584' : '#FF9F0A', fontSize: 17, fontWeight: 800,
          }}>
            {strokeIcon([up ? 'M4 17l6-6 4 4 6-8' : 'M4 7l6 6 4-4 6 8'], 16, 'currentColor', 3)}
            {signed(change, money(Math.abs(change)))} {since}
          </p>
        )}
      </div>
      <svg role="img" aria-label={chartLabel} style={abs({ left: 22, top: 380 })} width="346" height="312" viewBox="0 0 344 310">
        <defs>
          <linearGradient id="w2bValueLine" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#30D158" /><stop offset="0.7" stopColor="#7CF0A0" /><stop offset="1" stopColor="#9BE7FF" /></linearGradient>
          <linearGradient id="w2bValueArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#30D158" stopOpacity="0.38" /><stop offset="1" stopColor="#30D158" stopOpacity="0" /></linearGradient>
        </defs>
        <path d="M0 70H344M0 140H344M0 210H344M0 280H344" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
        <path d={area} fill="url(#w2bValueArea)" />
        <path className="wp-draw" d={line} fill="none" stroke="url(#w2bValueLine)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" pathLength="1" />
        <path d={`M${peak.x} ${peak.y}V${peak.y - 12}`} stroke="#FFCB05" strokeWidth="2" />
        <rect x={bubbleX - bubbleW / 2} y={bubbleY} width={bubbleW} height="34" rx="17" fill="#FFCB05" />
        <text x={bubbleX} y={bubbleY + 22} textAnchor="middle" fontFamily="-apple-system, BlinkMacSystemFont, sans-serif" fontSize="15" fontWeight="800" fill={DARK_INK}>{bubbleText}</text>
        <circle cx={peak.x} cy={peak.y} r="8" fill="#FFCB05" stroke="#0A0F12" strokeWidth="3" />
        {chart.peak !== pts.length - 1 && <circle cx={end.x} cy={end.y} r="6" fill="#FFFFFF" stroke="#0A0F12" strokeWidth="3" />}
        <g fontFamily="-apple-system, BlinkMacSystemFont, sans-serif" fontSize="12" fontWeight="700" fill="#AEB4BA">
          {chart.ticks.map((tick, i) => (
            <text key={tick.month} x={tick.x} y="306" textAnchor={i === 0 ? 'start' : 'middle'}>{short(tick.month)}</text>
          ))}
        </g>
      </svg>
      <dl style={abs({ left: 20, right: 20, top: 712, margin: 0, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8 })}>
        {tile(fill(t('wrapped.startTile'), { month: short(startM) }), money(value.start))}
        {tile(fill(t('wrapped.peakTile'), { month: short(peakMonth) }), money(value.peak), true)}
        {tile(t('wrapped.nowTile'), money(value.end))}
      </dl>
    </SlideFrame>
  )
}

// ── 008 Streak ─────────────────────────────────────────────────────────────
const WTP_ICON = (
  <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#FFE56E" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" /><path d="M9.2 9a3 3 0 0 1 5.6 1c0 2-3 2.6-3 4.4" /><path d="M12 17.5h.01" />
  </svg>
)

function StatTile({ iconEl, value, label, minHeight, valueSize, labelSize = 13, background = 'rgba(0,0,0,0.26)', valueGap = 4 }) {
  return (
    <div style={{ minHeight, borderRadius: 20, background, padding: 12, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      {iconEl}
      <dd style={{ margin: `${valueGap}px 0 0`, ...DISP, fontSize: valueSize, lineHeight: 1, whiteSpace: 'nowrap' }}>{value}</dd>
      <dt style={{ fontSize: labelSize, fontWeight: 600, lineHeight: 1.25 }}>{label}</dt>
    </div>
  )
}

const PIP_CAP = 63

function PunchCard({ days, t, locale }) {
  const shown = Math.min(days, PIP_CAP)
  const extra = days > PIP_CAP ? days - (PIP_CAP - 1) : 0
  const cells = extra ? PIP_CAP - 1 : shown
  const rows = Math.ceil((cells + (extra ? 1 : 0)) / 7)
  // The mockup's 28 px pips with 9 px gaps fit six weeks; longer streaks shrink to fit the box.
  const unit = Math.min(37, (220 + 9) / Math.max(1, rows))
  const pip = Math.round(unit * 28 / 37)
  const gap = Math.round(unit * 9 / 37)
  const { weeks, days: rest } = weeksAndDays(days)
  const span = [
    weeks > 0 && fill(t(weeks === 1 ? 'wrapped.weekOne' : 'wrapped.weeks'), { count: thousands(weeks, locale) }),
    rest > 0 && fill(t(rest === 1 ? 'wrapped.dayOne' : 'wrapped.days'), { count: rest }),
  ].filter(Boolean).join(t('wrapped.and'))
  return (
    <div role="img" aria-label={fill(t('wrapped.streakLabel'), { count: thousands(days, locale), span })} style={abs({
      left: 20, right: 20, top: 360, borderRadius: 24, background: 'rgba(0,0,0,0.26)', padding: 16, boxSizing: 'border-box',
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
    })}>
      <div style={{ alignSelf: 'stretch', display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 700 }}>
        <span style={{ color: '#FFE5DC' }}>{t('wrapped.longestStreakTitle')}</span><span>{span}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(7, ${pip}px)`, gap }}>
        {Array.from({ length: cells }, (_, i) => {
          const last = i === cells - 1 && !extra
          return (
            <span key={i} className="wp-pop" style={{
              width: pip, height: pip, borderRadius: pip / 2, display: 'grid', placeItems: 'center', animationDelay: `${i * 18}ms`,
              background: last ? 'radial-gradient(circle at 40% 35%, #FFFFFF, #FFE56E)' : 'radial-gradient(circle at 40% 35%, #FFE7B8, #FF9A4D)',
              boxShadow: last ? '0 0 16px rgba(255,229,110,0.9)' : 'none',
            }}>{icon(FLAME, Math.round(pip / 2), '#7A1E0E')}</span>
          )
        })}
        {extra > 0 && (
          <span style={{ width: pip, height: pip, borderRadius: pip / 2, display: 'grid', placeItems: 'center', background: 'radial-gradient(circle at 40% 35%, #FFFFFF, #FFE56E)', boxShadow: '0 0 16px rgba(255,229,110,0.9)', color: '#7A1E0E', fontSize: Math.round(pip * 0.4), fontWeight: 800 }}>+{extra}</span>
        )}
      </div>
    </div>
  )
}

function Streak({ ctx }) {
  const { data, t, locale } = ctx
  const days = data.longest_streak
  const tiles = [
    data.wtp_wins > 0 && { key: 'wtp', iconEl: WTP_ICON, value: thousands(data.wtp_wins, locale), label: t('wrapped.wtpWins') },
    data.quests_done > 0 && { key: 'quests', iconEl: strokeIcon([CHECK], 24, '#FFE56E', 2.6), value: thousands(data.quests_done, locale), label: t('wrapped.questsDone') },
    data.level > 0 && {
      key: 'level', iconEl: icon(SHIELD, 24, '#FFE56E'), value: fill(t('wrapped.levelShort'), { level: data.level }),
      label: data.xp_year > 0 ? fill(t('wrapped.xpYear'), { xp: thousands(data.xp_year, locale) }) : t('wrapped.trainerLevel'),
    },
  ].filter(Boolean)
  // No streak: the first tile grows into the hero (§6) and the others stay tiles under it.
  const heroTile = days > 0 ? null : tiles[0]
  const rest = heroTile ? tiles.slice(1) : tiles
  return (
    <SlideFrame
      background="linear-gradient(160deg, #B8441A, #6E1A0C)"
      decor={<>
        {glow(-40, 330, 470, 380, 'rgba(255,138,61,0.45)')}
        {watermark(FLAME, 180, 120, 260, 0.1)}
      </>}
      pill={pill(ctx, 'streak', '#FF8A3D', icon(FLAME, 13, '#FFFFFF'))}
    >
      <div style={abs({ left: 20, right: 20, top: 158 })}>
        <p style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{t('wrapped.keptComingBack')}</p>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginTop: 8 }}>
          {heroTile ? (
            <HeroNumber text={heroTile.value} size={178} spacing={-5} maxWidth={200} gradient="linear-gradient(100deg, #FFFFFF 15%, #FFE7B8 45%, #FFFFFF 85%)" />
          ) : (
            <HeroNumber count={days} locale={locale} size={178} spacing={-5} maxWidth={200} gradient="linear-gradient(100deg, #FFFFFF 15%, #FFE7B8 45%, #FFFFFF 85%)" />
          )}
          <p style={{ margin: '0 0 6px', ...DISP, fontSize: heroTile ? 32 : 46, lineHeight: 0.92 }}>
            {heroTile ? heroTile.label : lines(t(days === 1 ? 'wrapped.dayStreakOne' : 'wrapped.dayStreak'))}
          </p>
        </div>
      </div>
      {days > 0 && <PunchCard days={days} t={t} locale={locale} />}
      {rest.length > 0 && (
        <dl style={abs({ left: 20, right: 20, top: days > 0 ? 654 : 420, margin: 0, display: 'grid', gridTemplateColumns: `repeat(${rest.length}, minmax(0, 1fr))`, gap: 8 })}>
          {rest.map(tile => (
            <StatTile key={tile.key} iconEl={tile.iconEl} value={tile.value} label={tile.label}
              minHeight={days > 0 ? 130 : 200} valueSize={days > 0 ? (rest.length === 1 ? 48 : 34) : 56} labelSize={days > 0 ? 13 : 16} />
          ))}
        </dl>
      )}
    </SlideFrame>
  )
}

// ── 009 Badges ─────────────────────────────────────────────────────────────
function Badges({ ctx }) {
  const { data, t, locale } = ctx
  const { badges_earned: badges, trades, products } = data
  const rail = [
    trades?.count > 0 && { key: 'trades', iconEl: strokeIcon(['M4 8h14l-3-3M20 16H6l3 3'], 24, '#FFE56E', 2.4), value: thousands(trades.count, locale), label: t(trades.count === 1 ? 'wrapped.tradeOne' : 'wrapped.trades') },
    products?.count > 0 && { key: 'products', iconEl: strokeIcon(['M3 8l9-5 9 5v8l-9 5-9-5z', 'M3 8l9 5 9-5M12 13v8'], 24, '#FFE56E', 2.2), value: thousands(products.count, locale), label: t('wrapped.productsOpened') },
    data.level > 0 && { key: 'level', iconEl: icon(SHIELD, 24, '#FFE56E'), value: fill(t('wrapped.levelShort'), { level: data.level }), label: t('wrapped.trainerLevel') },
  ].filter(Boolean)
  const big = !(badges > 0)
  return (
    <SlideFrame
      background="linear-gradient(160deg, #343F50, #141A24)"
      texture={0.04}
      decor={glow(60, 110, 440, 360, 'rgba(255,203,5,0.3)')}
      pill={pill(ctx, 'badges', '#FFCB05', <Sparkle size={13} fill={DARK_INK} />, 'rgba(255,255,255,0.1)')}
    >
      {badges > 0 ? (
        <>
          <div style={abs({ left: 20, right: 20, top: 158 })}>
            <p style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{t('wrapped.youEarned')}</p>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginTop: 8 }}>
              <HeroNumber count={badges} locale={locale} size={178} spacing={-5} maxWidth={200}
                gradient="linear-gradient(100deg, #FFF6C8 10%, #FFCB05 40%, #FFE56E 60%, #FFF6C8 90%)" />
              <p style={{ margin: '0 0 6px', ...DISP, fontSize: 48, lineHeight: 1 }}>{t(badges === 1 ? 'wrapped.badgeOne' : 'wrapped.badges')}</p>
            </div>
          </div>
          <div role="img" aria-label={fill(t('wrapped.badgeCaseLabel'), { count: thousands(badges, locale) })} style={abs({
            left: 20, right: 20, top: 364, borderRadius: 24, background: 'rgba(0,0,0,0.3)', border: '1.5px solid rgba(255,203,5,0.35)',
            padding: 18, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 14,
          })}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, fontWeight: 700 }}>
              <span style={{ color: '#FFE56E' }}>{t('wrapped.badgeCase')}</span><span style={{ color: '#D1D5DB' }}>{data.year}</span>
            </div>
            <BadgeCase count={badges} />
          </div>
        </>
      ) : (
        <div style={abs({ left: 20, right: 20, top: 158 })}>
          <p style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{t('wrapped.youAlso')}</p>
          <p style={{ margin: '8px 0 0', ...DISP, fontSize: 64, lineHeight: 0.95 }}>{t('wrapped.alsoThisYear')}</p>
        </div>
      )}
      {rail.length > 0 && (
        <dl style={abs({
          left: 20, right: 20, top: big ? 330 : 620, margin: 0, display: 'grid', gap: big ? 10 : 8,
          gridTemplateColumns: `repeat(${big ? Math.min(2, rail.length) : rail.length}, minmax(0, 1fr))`,
        })}>
          {rail.map((item, i) => (
            <div key={item.key} style={big && rail.length === 3 && i === 2 ? { gridColumn: 'span 2' } : undefined}>
              <StatTile iconEl={item.iconEl} value={item.value} label={item.label} minHeight={big ? 200 : 140} valueSize={big ? 80 : 40}
                labelSize={big ? 18 : 14} background="rgba(255,255,255,0.08)" valueGap={6} />
            </div>
          ))}
        </dl>
      )}
    </SlideFrame>
  )
}

// ── 010 Summary ────────────────────────────────────────────────────────────
export function summaryModel(ctx) {
  const { data, t, locale, name, money, showDaily, n, total } = ctx
  return trainerCardModel({ data, t, name, locale, money, showDaily, footer: fill(t('wrapped.cardFooter'), { n: pad3(n), total: pad3(total) }) })
}

function Summary({ ctx }) {
  const { t, onShare, onRestart } = ctx
  const model = summaryModel(ctx)
  const p = model.palette
  return (
    <SlideFrame
      background={`radial-gradient(110% 70% at 50% 40%, ${p.night[0]} 0%, ${p.night[1]} 60%, ${p.night[2]} 100%)`}
      texture={0}
      decor={burst(-200, 60, 790, 680, hexAlpha(p.solid, model.light ? 0.12 : 0.16), 6, 18, 30)}
    >
      <div className="wp-pop" style={abs({ left: 17, top: 116 })}>
        <TrainerCard model={model} label={trainerCardLabel(model, t)}
          shadow={model.light ? '0 30px 70px rgba(0,0,0,0.6)' : `0 30px 70px rgba(0,0,0,0.6), 0 0 60px ${hexAlpha(p.solid, 0.35)}`} />
      </div>
      <div style={abs({ left: 24, right: 24, top: 636, display: 'flex', flexDirection: 'column', gap: 10 })}>
        <button type="button" onClick={onShare} data-testid="wrapped-share" style={{
          minHeight: 52, border: 0, borderRadius: 26, background: '#FFFFFF', color: p.night[1], fontFamily: 'inherit', fontSize: 17, fontWeight: 800,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, cursor: 'pointer',
        }}>
          {strokeIcon([SHARE], 20, 'currentColor', 2.4)}{t('wrapped.shareTrainerCard')}
        </button>
        <button type="button" onClick={onRestart} data-testid="wrapped-restart" style={{
          minHeight: 48, border: 0, borderRadius: 24, background: 'rgba(255,255,255,0.14)', color: '#FFFFFF', fontFamily: 'inherit',
          fontSize: 16, fontWeight: 700, cursor: 'pointer',
        }}>{t('wrapped.watchAgain')}</button>
      </div>
    </SlideFrame>
  )
}

const SLIDES = {
  cover: Cover, cards: Cards, first: First, pull: Pull, favourites: Favourites,
  sets: Sets, value: Value, streak: Streak, badges: Badges, summary: Summary,
}

/** The ink of each slide's chrome (progress and close): dark on the light top-pull slide. */
export function slideInk(id, data) {
  if (id === 'pull') return DARK_INK
  if (id === 'favourites') {
    const key = personaKey(data) || topTypeKey(data) || 'psychic'
    return paletteFor(key).ink
  }
  return '#FFFFFF'
}

export default function Slide({ id, ctx }) {
  const Component = SLIDES[id]
  return Component ? <Component ctx={ctx} /> : null
}
