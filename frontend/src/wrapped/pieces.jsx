import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { prefersReducedMotion } from '../hooks/useTilt'
import {
  BADGE_TINTS, DISPLAY_FONT, FOIL_COIN, FOIL_FRAME, GLYPHS, SPARKLE, STAGE_H, STAGE_W, TEXT_FONT,
} from './theme'
import { CARD_H, CARD_W, cardColours, cssFont, measureText, trainerCardLayout } from './trainerCard'
import { pad3, thousands } from './wrapped'

// The shared pieces of the Wrapped v2 slides (docs/WRAPPED_REDESIGN.md §7): the frame with its
// collector pill, hero numbers, card heroes, the energy coin, the badge case and the trainer card.
// Sizes and colours are the Wave 2b mockups' own, in stage units (one stage is 390 × 844).

export const DISP = { fontFamily: DISPLAY_FONT, fontWeight: 900 }
export const foilText = gradient => ({
  background: gradient, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
})

/** Where the 390 × 844 stage sits inside the scaled "world" that fills the screen. */
export const StageContext = createContext({ offX: 0, offY: 0 })

// The display face loads once; text that is fitted by measuring re-fits when it arrives.
let fontReady = false
const fontListeners = new Set()
export function loadDisplayFont() {
  if (fontReady || typeof document === 'undefined' || !document.fonts?.load) return Promise.resolve()
  return document.fonts.load(`900 100px ${DISPLAY_FONT}`).catch(() => {}).then(() => {
    fontReady = true
    fontListeners.forEach(listener => listener())
  })
}
export function useDisplayFont() {
  useEffect(() => { loadDisplayFont() }, [])
  return useSyncExternalStore(listener => {
    fontListeners.add(listener)
    return () => fontListeners.delete(listener)
  }, () => fontReady, () => false)
}

export const largeImage = url => (url ? String(url).replace(/\/small$/, '/large') : url)

export function Sparkle({ size, fill = '#FFFFFF', style }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" style={style}><path d={SPARKLE} fill={fill} /></svg>
  )
}

/** An original energy glyph (§3.2) in a 24 grid. */
export function TypeGlyph({ type, size, color = '#FFFFFF', width, detail = false }) {
  const glyph = GLYPHS[type] || GLYPHS.colorless
  const strokeWidth = width ?? glyph.width
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24">
      {(glyph.fill || []).map(d => <path key={d} d={d} fill={color} fillRule={glyph.evenOdd ? 'evenodd' : undefined} />)}
      {(glyph.stroke || []).map(d => (
        <path key={d} d={d} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {detail && (glyph.big || []).map(d => <path key={d} d={d} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />)}
      {(glyph.circles || []).map(([cx, cy, r]) => (
        <circle key={`${cx}-${r}`} cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={strokeWidth} />
      ))}
    </svg>
  )
}

/** The page: type background, foil lines, decoration, then the collector pill and the content. */
export function SlideFrame({ background, texture = 0.05, ink = '#FFFFFF', decor, pill, children, label }) {
  const { offX, offY } = useContext(StageContext)
  return (
    <div aria-label={label} style={{ position: 'absolute', inset: 0, overflow: 'hidden', color: ink, fontFamily: TEXT_FONT, lineHeight: 'normal', background }}>
      {texture > 0 && (
        <div aria-hidden="true" style={{ position: 'absolute', inset: 0, background: `repeating-linear-gradient(115deg, rgba(255,255,255,${texture}) 0 2px, transparent 2px 16px)` }} />
      )}
      <div style={{ position: 'absolute', left: offX, top: offY, width: STAGE_W, height: STAGE_H }}>
        {decor}
        {pill && <Pill {...pill} />}
        {children}
      </div>
    </div>
  )
}

/** "◆ 004/010 · Top pull" (§3.4). `n` and `total` come from the slides `selectSlides` kept. */
export function Pill({ coin, glyph, text, n, total, name, background = 'rgba(0,0,0,0.25)' }) {
  return (
    <div style={{
      position: 'absolute', left: 20, top: 112, display: 'flex', alignItems: 'center', gap: 8, height: 30,
      padding: '0 12px 0 5px', borderRadius: 15, background, fontSize: 13, fontWeight: 700, letterSpacing: 0.3,
      boxSizing: 'border-box', whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 22, height: 22, borderRadius: 11, background: coin, display: 'grid', placeItems: 'center' }}>{glyph}</span>
      <span>{text ?? `◆ ${pad3(n)}/${pad3(total)} · ${name}`}</span>
    </div>
  )
}

const ease = x => 1 - (1 - x) ** 3

/** Counts up to `target` once (§2.5), unless Reduce Motion is on. */
export function useCountUp(target, { duration = 900 } = {}) {
  const [reduced] = useState(prefersReducedMotion)
  const [value, setValue] = useState(() => (reduced ? target : 0))
  useEffect(() => {
    if (reduced || !Number.isFinite(target)) {
      setValue(target)
      return undefined
    }
    let frame
    const start = performance.now()
    const step = now => {
      const progress = Math.min(1, (now - start) / duration)
      setValue(Math.round(target * ease(progress)))
      if (progress < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [target, reduced, duration])
  return value
}

/**
 * A giant numeral (§2.3): the mockups' condensed heavy face with a foil fill. Shrinks to `maxWidth`
 * when the number is long. `count` counts it up from zero; `text` is shown as is (amounts).
 */
export function HeroNumber({ count, text, locale, size, lineHeight = 0.8, spacing = 0, gradient, maxWidth, style, testId }) {
  useDisplayFont()
  const counted = useCountUp(count ?? 0)
  const shown = text ?? thousands(counted, locale)
  const final = text ?? thousands(count, locale)
  const natural = measureText(final, { size, weight: 900, display: true }) + spacing * final.length
  const fontSize = maxWidth && natural > maxWidth ? Math.floor(size * (maxWidth / natural)) : size
  return (
    <p data-testid={testId} style={{
      margin: 0, ...DISP, fontSize, lineHeight, letterSpacing: spacing * (fontSize / size), whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums', ...(gradient ? foilText(gradient) : null), ...style,
    }}>{shown}</p>
  )
}

/** A single display line that shrinks to fit `maxWidth` (names). */
export function FitLine({ text, size, maxWidth, min = Math.round(size * 0.55), style, as: Tag = 'p' }) {
  useDisplayFont()
  const natural = measureText(text, { size, weight: 900, display: true })
  const fontSize = natural > maxWidth ? Math.max(min, Math.floor(size * (maxWidth / natural))) : size
  return (
    <Tag style={{ margin: 0, ...DISP, fontSize, lineHeight: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth, ...style }}>{text}</Tag>
  )
}

/** The original card back (cover fan, image fallback): lattice, foil sheen and a ring medallion. */
export function CardBack({ width, height, radius, border = 0, name, front = false }) {
  const ring = Math.round(Math.min(width, height) * 0.44)
  return (
    <div aria-hidden={name ? undefined : 'true'} style={{
      position: 'relative', width, height, borderRadius: radius, boxSizing: 'border-box', overflow: 'hidden',
      border: border ? `${border}px solid #F3EEDC` : 0,
      background: `repeating-linear-gradient(45deg, rgba(255,255,255,0.09) 0 2px, transparent 2px 12px), repeating-linear-gradient(-45deg, rgba(255,255,255,0.09) 0 2px, transparent 2px 12px), linear-gradient(160deg, ${front ? '#5A43D0' : '#4B36B8'}, #1E1650)`,
    }}>
      {front && <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(115deg, transparent 22%, rgba(255,155,210,0.35) 40%, rgba(155,231,255,0.35) 54%, transparent 72%)' }} />}
      {(front || name) && (
        <div style={{
          position: 'absolute', left: '50%', top: name ? '42%' : '50%', width: ring, height: ring, margin: `-${ring / 2}px 0 0 -${ring / 2}px`,
          borderRadius: '50%', border: `${Math.max(2, Math.round(ring / 18))}px solid #FFCB05`, boxSizing: 'border-box', display: 'grid',
          placeItems: 'center', background: 'rgba(20,16,60,0.6)',
        }}><Sparkle size={Math.round(ring * 0.47)} fill="#FFCB05" /></div>
      )}
      {name && (
        <p style={{
          position: 'absolute', left: 6, right: 6, bottom: Math.round(height * 0.1), margin: 0, textAlign: 'center',
          color: '#FFFFFF', fontSize: Math.max(10, Math.round(width / 11)), fontWeight: 800, lineHeight: 1.15,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{name}</p>
      )}
    </div>
  )
}

/** A card picture from the image proxy; if it fails, the drawn card back with the name (§6). */
export function CardImage({ src, name, width, height, radius }) {
  const [failed, setFailed] = useState(!src)
  useEffect(() => setFailed(!src), [src])
  if (failed) return <CardBack width={width} height={height} radius={radius} name={name} />
  return (
    <img src={src} alt="" width={width} height={height} draggable="false" onError={() => setFailed(true)}
      style={{ display: 'block', width, height, borderRadius: radius, objectFit: 'cover', background: 'rgba(0,0,0,0.25)' }} />
  )
}

/** A card in a foil frame with the holo sheen over it (§4 top pull; the trainer card's art window). */
export function HoloCard({ src, name, width, height, pad = 5, radius = 18, shadow, sheen = true }) {
  const inner = radius - pad
  return (
    <div style={{ width, height, borderRadius: radius, padding: pad, boxSizing: 'border-box', background: FOIL_FRAME, boxShadow: shadow }}>
      <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: inner, overflow: 'hidden' }}>
        <CardImage src={src} name={name} width={width - pad * 2} height={height - pad * 2} radius={inner} />
        {sheen && <div aria-hidden="true" className="wp-sheen" style={{ position: 'absolute', inset: 0, background: 'linear-gradient(115deg, transparent 18%, rgba(255,155,210,0.38) 36%, rgba(155,231,255,0.38) 50%, rgba(255,246,200,0.3) 60%, transparent 76%)' }} />}
      </div>
    </div>
  )
}

/** The big energy coin (§4 favourites): a donut filled to `percent`, the glyph and a caption. */
export function TypeCoin({ palette, type, percent, size = 240, ring = 18, children, label }) {
  return (
    <div role="img" aria-label={label} style={{
      width: size, height: size, borderRadius: size / 2, padding: ring, boxSizing: 'border-box',
      background: `conic-gradient(${palette.light} 0 ${percent}%, rgba(255,255,255,0.16) ${percent}% 100%)`,
      boxShadow: `0 0 60px ${palette.glow}`,
    }}>
      <div style={{
        width: '100%', height: '100%', borderRadius: '50%', background: `radial-gradient(circle at 50% 35%, ${palette.coin[0]}, ${palette.coin[1]})`,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
      }}>
        {type && <TypeGlyph type={type} size={58} color={palette.ink} width={type === 'psychic' ? 1.8 : undefined} detail />}
        {children}
      </div>
    </div>
  )
}

const OCTAGON = 'polygon(30% 0, 70% 0, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0 70%, 0 30%)'

/** Gym-badge medallions (§3.7), 6 to a row, tinted through the type palette; "+N" past `max`. */
export function BadgeCase({ count, max = 18 }) {
  const shown = count > max ? max - 1 : count
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: '12px 8px', justifyItems: 'center' }}>
      {Array.from({ length: shown }, (_, i) => (
        <span key={i} className="wp-pop" style={{ width: 46, height: 46, clipPath: OCTAGON, background: BADGE_TINTS[i % BADGE_TINTS.length], display: 'grid', placeItems: 'center', animationDelay: `${i * 40}ms` }}>
          <span style={{ width: 34, height: 34, clipPath: OCTAGON, background: 'linear-gradient(160deg, rgba(255,255,255,0.45), rgba(0,0,0,0.25))', display: 'grid', placeItems: 'center' }}>
            <Sparkle size={18} />
          </span>
        </span>
      ))}
      {count > max && (
        <span style={{ width: 46, height: 46, clipPath: OCTAGON, background: 'rgba(255,203,5,0.25)', display: 'grid', placeItems: 'center', color: '#FFE56E', fontSize: 15, fontWeight: 800 }}>
          +{count - shown}
        </span>
      )}
    </div>
  )
}

/** The round "SET 26" mark (cover; the trainer card when there is no card to show). */
export function SetMark({ year, size = 92 }) {
  return (
    <div aria-hidden="true" style={{
      width: size, height: size, borderRadius: size / 2, padding: 4, boxSizing: 'border-box',
      background: 'conic-gradient(#FFE56E, #FF9BD2, #9BE7FF, #B4F5A8, #FFE56E)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
    }}>
      <div style={{ width: '100%', height: '100%', borderRadius: '50%', background: '#121433', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.5, color: '#FFE56E', lineHeight: '12px' }}>SET</span>
        <span style={{ ...DISP, fontSize: 30, lineHeight: 1, color: '#FFFFFF' }}>{String(year).slice(-2)}</span>
      </div>
    </div>
  )
}

export function FoilCoin({ size = 22, sparkle = 12 }) {
  return (
    <span style={{ width: size, height: size, borderRadius: size / 2, background: FOIL_COIN, display: 'grid', placeItems: 'center' }}>
      <Sparkle size={sparkle} fill="#1D1600" />
    </span>
  )
}

const textStyle = (item, colour) => ({
  // `font` first: the shorthand would reset a line height set before it.
  font: cssFont(item.font), position: 'absolute', top: item.y, height: item.lh, lineHeight: `${item.lh}px`, margin: 0,
  whiteSpace: 'nowrap', letterSpacing: item.font.spacing || 0, color: colour,
  ...(item.align === 'right' ? { right: CARD_W - item.x, textAlign: 'right' } : { left: item.x }),
})

/**
 * The trainer card (§4 slide 010), 356 × 498. Renders `trainerCardLayout` with absolute positions;
 * share picture A draws the same layout (shareWrapped.js), so the two match.
 */
export function TrainerCard({ model, label, shadow = '0 30px 70px rgba(0,0,0,0.6)' }) {
  useDisplayFont()
  const L = trainerCardLayout(model)
  const c = cardColours(model)
  const { art, mini } = L
  return (
    <div role="img" aria-label={label} style={{ position: 'relative', width: CARD_W, height: CARD_H, borderRadius: 22, padding: 6, boxSizing: 'border-box', background: FOIL_FRAME, boxShadow: shadow }}>
      <div aria-hidden="true" style={{ position: 'absolute', left: 6, top: 6, right: 6, bottom: 6, borderRadius: 17, overflow: 'hidden', background: `linear-gradient(165deg, ${c.face[0]}, ${c.face[1]})` }}>
        <div style={{ position: 'absolute', inset: 0, background: `repeating-linear-gradient(115deg, ${c.texture} 0 2px, transparent 2px 14px)` }} />
      </div>
      <div aria-hidden="true" style={{ position: 'absolute', inset: 0, color: c.ink }}>
        <p style={textStyle(L.header.label, c.label)}>{L.header.label.text}</p>
        <p style={textStyle(L.header.name, c.ink)}>{L.header.name.text}</p>
        <p style={textStyle(L.header.persona, c.ink)}>{L.header.persona.text}</p>
        <span style={{
          position: 'absolute', left: L.header.coin.x, top: L.header.coin.y, width: 40, height: 40, borderRadius: 20, boxSizing: 'border-box',
          background: c.coin, border: `2px solid ${c.coinBorder}`, display: 'grid', placeItems: 'center',
        }}><TypeGlyph type={model.key} size={model.key === 'colorless' ? 20 : 22} color={c.glyph} width={model.key === 'colorless' ? 2.6 : 2.4} /></span>
        {L.chip && (
          <>
            <span style={{ position: 'absolute', left: L.chip.x, top: L.chip.y, width: L.chip.w, height: L.chip.h, boxSizing: 'border-box', borderRadius: 8, border: `1.5px dashed ${c.chipBorder}` }} />
            <p style={textStyle(L.chip.text, c.label)}>{L.chip.text.text}</p>
          </>
        )}
        <div style={{
          position: 'absolute', left: art.x, top: art.y, width: art.w, height: art.h, boxSizing: 'border-box', borderRadius: 10,
          border: `3px solid ${c.artBorder}`, overflow: 'hidden',
          background: `radial-gradient(circle at ${model.light ? '35%' : '30%'} 50%, ${c.artGlow}, transparent 60%), linear-gradient(160deg, ${c.artBg[0]}, ${c.artBg[1]})`,
        }} />
        {mini && (
          <div style={{ position: 'absolute', left: mini.x, top: mini.y, transform: `rotate(${mini.rot}deg)`, boxShadow: '0 10px 22px rgba(0,0,0,0.5)', borderRadius: 8 }}>
            {model.light
              ? <CardImage src={largeImage(model.art.image)} name={model.art.name} width={mini.w} height={mini.h} radius={9} />
              : <HoloCard src={largeImage(model.art.image)} name={model.art.name} width={mini.w} height={mini.h} pad={3} radius={8} sheen={false} />}
          </div>
        )}
        {L.mark && <div style={{ position: 'absolute', left: L.mark.x, top: L.mark.y }}><SetMark year={model.year} /></div>}
        {L.artItems.map(item => (
          <p key={`${item.role}-${item.y}`} style={textStyle(item, item.role === 'label' ? c.artLabel : item.role === 'price' ? c.price : c.ink)}>{item.text}</p>
        ))}
        {L.sparkle && <Sparkle size={16} style={{ position: 'absolute', left: L.sparkle.x, top: L.sparkle.y }} />}
        {L.stats.map(stat => (
          <div key={`${stat.dt.x}-${stat.dt.y}`}>
            <p style={textStyle(stat.dt, model.light ? c.soft : c.label)}>{stat.dt.text}</p>
            <p style={textStyle(stat.dd, c.ink)}>{stat.dd.text}</p>
          </div>
        ))}
        <span style={{ position: 'absolute', left: 20, right: 20, top: L.footer.y, height: 1, background: c.rule }} />
        <p style={textStyle(L.footer.rarity, c.rarity)}>{L.footer.rarity.text}</p>
        <p style={textStyle(L.footer.right, model.light ? c.soft : c.label)}>{L.footer.right.text}</p>
      </div>
    </div>
  )
}
