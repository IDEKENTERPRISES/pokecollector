import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PixelArt from './PixelArt'
import { BALL_BASE, BALL_LID, BURST, GLYPH_HEIGHT, GROUND_FOR_TYPE, SPARKLE, artSize, groundFor, textArt } from './art'
import {
  AUTO_CONTINUE_MS,
  MAX_SMOOTH_SCALE,
  OPEN_TWITCH_AT,
  REDUCED_MOTION_HOLD_MS,
  SHOW_SHINY_SPARKLES,
  SHOW_WILD_BOX,
  SPRITE_TARGET_PX,
  TIMELINE,
  TWITCH_EVERY,
  UNITS,
  WAIT_TWITCHES,
} from './config'
import { factFor } from './entryStore'
import { splashText, typeColour } from './format'
import { fitSprite, measureBounds } from './spriteFit'
import './splash.css'

const HINT_AT = 600
const SPARKLES = [
  { left: '8%', top: '14%', delay: 0 },
  { left: '84%', top: '6%', delay: 210 },
  { left: '92%', top: '58%', delay: 400 },
  { left: '2%', top: '64%', delay: 560 },
]
const now = () => (globalThis.performance?.now?.() ?? Date.now())

/** The custom properties for what runs from the start, scaled by `speed` (slow motion). */
function startStyle(speed) {
  const ms = value => `${Math.round(value * speed)}ms`
  return {
    '--pc-roll': ms(TIMELINE.roll),
    '--pc-settle': ms(TIMELINE.settle),
    '--pc-twitch': ms(TIMELINE.twitch),
    '--pc-twitch-1': ms(TIMELINE.firstTwitchAt),
    '--pc-twitch-2': ms(TIMELINE.firstTwitchAt + TWITCH_EVERY),
    '--pc-lid': ms(TIMELINE.lid),
    '--pc-burst': ms(TIMELINE.burst),
    '--pc-flash': ms(TIMELINE.flash),
    '--pc-pop': ms(TIMELINE.pop),
    '--pc-card': ms(TIMELINE.card),
    '--pc-sparkle': ms(TIMELINE.sparkle),
    '--pc-hint-at': ms(HINT_AT),
  }
}

/** The opening's delays, counted from the moment `.is-open` was applied (`open.appliedAt`). */
function openStyle(open, speed, letters) {
  const scaled = value => value * speed
  const at = value => `${Math.max(0, Math.round(value - open.appliedAt))}ms`
  const openAt = open.twitchAt + scaled(TIMELINE.twitch / 2)
  const popAt = openAt + scaled(TIMELINE.popDelay)
  const boxAt = popAt + scaled(TIMELINE.boxDelay)
  const firstLine = scaled(letters[0] * TIMELINE.perLetter)
  return {
    '--pc-open-twitch-at': at(open.twitchAt),
    '--pc-open-at': at(openAt),
    '--pc-flash-at': at(openAt + scaled(TIMELINE.flashDelay)),
    '--pc-ball-out-at': at(popAt + scaled(60)),
    '--pc-pop-at': at(popAt),
    '--pc-sparkle-at': at(popAt + scaled(200)),
    '--pc-box-at': at(boxAt),
    '--pc-type-1-at': at(boxAt + scaled(80)),
    '--pc-type-1': `${Math.round(firstLine)}ms`,
    '--pc-type-2-at': at(boxAt + scaled(80) + firstLine),
    '--pc-type-2': `${Math.round(scaled(letters[1] * TIMELINE.perLetter))}ms`,
    '--pc-chars-1': String(Math.max(1, letters[0])),
    '--pc-chars-2': String(Math.max(1, letters[1])),
    '--pc-card-at': at(popAt + scaled(TIMELINE.cardDelay)),
  }
}

function TextLine({ text, className }) {
  const art = useMemo(() => textArt(text), [text])
  const { width } = artSize(art)
  return (
    <PixelArt
      art={art}
      className={className}
      style={{ width: `calc(var(--font-px) * ${width})`, height: `calc(var(--font-px) * ${GLYPH_HEIGHT})` }}
    />
  )
}

/**
 * The launch splash: a 16-bit Poké Ball rolls in over ground that matches the Pokémon's type,
 * twitches twice and opens on the third twitch with light in the type's colour; the Pokémon of
 * the day pops out, a "Wild … appeared!" box types itself out and the Pokédex card fades in.
 * CSS keyframes only (splash.css), timed from config.js. While `entry` is still loading the ball
 * keeps twitching, then asks for the starter (`onWaitTimeout`). Tapping, clicking, Escape, Enter
 * or Space skips it at any moment. `mode` 'still' is the Reduce Motion version.
 */
export default function Splash({
  entry,
  spriteSrc,
  factTurn = 0,
  mode = 'full',
  speed = 1,
  autoContinueMs = AUTO_CONTINUE_MS,
  hold = false,
  t,
  language = 'en',
  onFinish,
  onWaitTimeout,
}) {
  const still = mode === 'still'
  const ready = Boolean(entry && spriteSrc)
  const startedAt = useRef(null)
  if (startedAt.current === null) startedAt.current = now()
  const elapsed = () => now() - startedAt.current

  // Ready on the first render (a pre-fetched entry): the opening is scheduled from the start.
  const [open, setOpen] = useState(() => (ready ? { twitchAt: still ? 0 : OPEN_TWITCH_AT * speed, appliedAt: 0 } : null))
  const [waits, setWaits] = useState(0)
  const [exiting, setExiting] = useState(null) // null | 'auto' | 'skip'
  const [revealed, setRevealed] = useState(false)
  const [announced, setAnnounced] = useState(false)
  const [fit, setFit] = useState(null)
  const [spriteFailed, setSpriteFailed] = useState(false)
  const rootRef = useRef(null)
  const skipRef = useRef(null)
  const readyRef = useRef(ready)
  readyRef.current = ready

  const fact = useMemo(() => factFor(entry, factTurn), [entry, factTurn])
  const text = useMemo(
    () => (entry ? splashText(entry, { t, language, units: UNITS, fact }) : null),
    [entry, t, language, fact],
  )
  const waitsForTap = hold || autoContinueMs == null
  const close = useCallback(how => setExiting(current => current || how), [])

  useEffect(() => {
    skipRef.current?.focus({ preventScroll: true })
  }, [])

  useEffect(() => {
    setFit(null)
    setSpriteFailed(false)
  }, [spriteSrc])

  // Ready later, but before the third twitch: that twitch still opens it.
  useEffect(() => {
    if (open || !ready) return
    const time = elapsed()
    if (still) setOpen({ twitchAt: time, appliedAt: time })
    else if (time <= OPEN_TWITCH_AT * speed) setOpen({ twitchAt: OPEN_TWITCH_AT * speed, appliedAt: time })
  }, [open, ready, still, speed]) // eslint-disable-line react-hooks/exhaustive-deps

  // Not ready by the third twitch: one more twitch per slot until it is, then the starter.
  useEffect(() => {
    if (open) return undefined
    const slot = still ? WAIT_TWITCHES : waits
    const slotAt = (OPEN_TWITCH_AT + slot * TWITCH_EVERY) * speed
    const timer = setTimeout(() => {
      if (still) onWaitTimeout?.()
      else if (readyRef.current) setOpen({ twitchAt: slotAt, appliedAt: elapsed() })
      else {
        if (slot >= WAIT_TWITCHES) onWaitTimeout?.()
        setWaits(slot + 1)
      }
    }, Math.max(0, slotAt - elapsed()))
    return () => clearTimeout(timer)
  }, [open, waits, still, speed]) // eslint-disable-line react-hooks/exhaustive-deps

  // The reveal and auto-continue run on timers taken from the same constants as the CSS.
  useEffect(() => {
    if (!open || exiting) return undefined
    const revealAt = still ? open.appliedAt : open.twitchAt + (TIMELINE.twitch / 2 + TIMELINE.popDelay) * speed
    const timers = [setTimeout(() => setRevealed(true), Math.max(0, revealAt - elapsed()))]
    if (!waitsForTap) {
      const after = (still ? REDUCED_MOTION_HOLD_MS : autoContinueMs) * speed
      timers.push(setTimeout(() => close('auto'), Math.max(0, revealAt + after - elapsed())))
    }
    return () => timers.forEach(clearTimeout)
  }, [open, exiting, still, speed, waitsForTap, autoContinueMs, close]) // eslint-disable-line react-hooks/exhaustive-deps

  // A live region only announces changes, so the text goes in just after the reveal.
  useEffect(() => {
    if (!revealed) return undefined
    const timer = setTimeout(() => setAnnounced(true), 80)
    return () => clearTimeout(timer)
  }, [revealed])

  useEffect(() => {
    if (!exiting) return undefined
    const duration = exiting === 'skip' ? TIMELINE.skipFade : TIMELINE.fadeOut * speed
    const timer = setTimeout(() => onFinish?.(exiting), duration)
    return () => clearTimeout(timer)
  }, [exiting]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = event => {
      if (event.key !== 'Escape' && event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      close('skip')
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [close])

  // Animated and artwork sprites scale smoothly; pixel sprites by whole numbers. Either way the
  // visible pixels stand on the ground, however much transparent margin the file has.
  const measureSprite = event => {
    const image = event.currentTarget
    const pixel = parseFloat(getComputedStyle(rootRef.current).getPropertyValue('--px')) || 6
    setFit(fitSprite({
      width: image.naturalWidth,
      height: image.naturalHeight,
      bounds: measureBounds(image),
      target: (SPRITE_TARGET_PX * pixel) / 6,
      smooth: entry?.sprite_style !== 'pixel',
      maxSmooth: MAX_SMOOTH_SCALE,
    }))
  }

  const groundName = GROUND_FOR_TYPE[String(entry?.types?.[0] ?? '').toLowerCase()] ?? 'grass'
  const letters = text ? [[...text.wild[0]].length, [...text.wild[1]].length] : [1, 1]
  const style = {
    ...startStyle(speed),
    ...(open ? openStyle(open, speed, letters) : null),
    '--pc-exit': `${exiting === 'skip' ? TIMELINE.skipFade : Math.round(TIMELINE.fadeOut * speed)}ms`,
    '--pc-type': typeColour(entry?.types),
  }
  const classes = ['pc-splash', still && 'is-still', open && 'is-open', exiting && 'is-exiting'].filter(Boolean).join(' ')

  return (
    <div
      ref={rootRef}
      className={classes}
      style={style}
      role="dialog"
      aria-modal="true"
      aria-label={t('splash.label')}
      data-testid="launch-splash"
      data-mode={mode}
      data-open={open ? 'true' : 'false'}
      data-revealed={revealed ? 'true' : 'false'}
      data-ground={groundName}
      data-shiny={entry?.shiny ? 'true' : undefined}
      onClick={() => close('skip')}
    >
      <div className="pc-splash__flash" aria-hidden="true" />
      <div className="pc-splash__scene" aria-hidden="true">
        <div className="pc-splash__aura" />
        <div className="pc-splash__pokemon">
          {spriteSrc && !spriteFailed && (
            <div className="pc-splash__sprite-box" style={fit ?? undefined} data-sized={fit ? 'true' : undefined}>
              <img
                className="pc-splash__sprite"
                src={spriteSrc}
                alt=""
                draggable="false"
                data-style={entry?.sprite_style ?? 'animated'}
                onLoad={measureSprite}
                onError={() => setSpriteFailed(true)}
              />
              {entry?.shiny && SHOW_SHINY_SPARKLES && SPARKLES.map(({ left, top, delay }) => (
                <PixelArt
                  key={left}
                  art={SPARKLE}
                  className="pc-splash__sparkle"
                  style={{ left, top, '--pc-sparkle-delay': `${Math.round(delay * speed)}ms` }}
                />
              ))}
            </div>
          )}
        </div>
        <div className="pc-splash__ball">
          <div className="pc-splash__ball-fade">
            <div className="pc-splash__settle">
              <div className="pc-splash__twitch pc-splash__twitch--1">
                <div className="pc-splash__twitch pc-splash__twitch--2">
                  <div className="pc-splash__twitch pc-splash__twitch--open">
                    <div className="pc-splash__spin">
                      <div key={waits} className={`pc-splash__wait${waits ? ' is-twitching' : ''}`}>
                        <PixelArt art={BALL_LID} className="pc-splash__lid" />
                        <PixelArt art={BALL_BASE} className="pc-splash__base" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <PixelArt art={BURST} className="pc-splash__burst" />
        <PixelArt key={groundName} art={groundFor(entry?.types)} className="pc-splash__ground" />
      </div>
      {text && SHOW_WILD_BOX && (
        <div className="pc-splash__box" aria-hidden="true">
          <TextLine text={text.wild[0]} className="pc-splash__line pc-splash__line--1" />
          <TextLine text={text.wild[1]} className="pc-splash__line pc-splash__line--2" />
        </div>
      )}
      {text && (
        <div className="pc-splash__card" aria-hidden={revealed ? undefined : 'true'} data-testid="launch-splash-card">
          <p className="pc-splash__number">
            <span className="pc-splash__pip" aria-hidden="true" />
            {text.number}
            {entry.shiny && <span className="pc-splash__shiny">★ {t('splash.shiny')}</span>}
          </p>
          <h2 className="pc-splash__name">{text.name}</h2>
          <p className="pc-splash__meta">{text.meta}</p>
          {(text.height || text.weight) && (
            <dl className="pc-splash__stats">
              {text.height && <div><dt>{t('splash.height')}</dt><dd>{text.height}</dd></div>}
              {text.weight && <div><dt>{t('splash.weight')}</dt><dd>{text.weight}</dd></div>}
            </dl>
          )}
          {text.fact && (
            <p className="pc-splash__fact">
              <span className="pc-splash__fact-label">{text.fact.label}</span>
              {text.fact.title && <strong>{text.fact.title}: </strong>}
              {text.fact.text}
            </p>
          )}
        </div>
      )}
      <p className="pc-splash__live" aria-live="polite">{announced && text ? text.announcement : ''}</p>
      <button
        ref={skipRef}
        type="button"
        className="pc-splash__skip"
        data-testid="launch-splash-skip"
        onClick={event => {
          event.stopPropagation()
          close('skip')
        }}
      >
        <span className="pc-splash__skip-touch">{t(waitsForTap ? 'splash.tapToContinue' : 'splash.tapToSkip')}</span>
        <span className="pc-splash__skip-mouse">{t(waitsForTap ? 'splash.clickToContinue' : 'splash.clickToSkip')}</span>
      </button>
    </div>
  )
}
