import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PixelArt from './PixelArt'
import { BALL_BASE, BALL_LID, BURST, GRASS } from './art'
import {
  AUTO_CONTINUE_MS,
  CARD_AT,
  OPEN_AT,
  POP_AT,
  REDUCED_MOTION_HOLD_MS,
  REVEAL_AT,
  SPRITE_TARGET_PX,
  TIMELINE,
  WEIGHT_UNIT,
} from './config'
import { splashText, typeColour } from './format'
import { fitSprite, measureBounds } from './spriteFit'
import './splash.css'

const HINT_AT = 600

/** The custom properties splash.css reads every time from, scaled by `speed` (slow motion). */
function timelineStyle(speed) {
  const ms = value => `${Math.round(value * speed)}ms`
  const twitchEvery = TIMELINE.twitch + TIMELINE.twitchGap
  return {
    '--pc-roll': ms(TIMELINE.roll),
    '--pc-settle': ms(TIMELINE.settle),
    '--pc-twitch': ms(TIMELINE.twitch),
    '--pc-twitch-1': ms(TIMELINE.firstTwitchAt),
    '--pc-twitch-2': ms(TIMELINE.firstTwitchAt + twitchEvery),
    '--pc-twitch-3': ms(TIMELINE.firstTwitchAt + 2 * twitchEvery),
    '--pc-open-at': ms(OPEN_AT),
    '--pc-lid': ms(TIMELINE.lid),
    '--pc-burst': ms(TIMELINE.burst),
    '--pc-flash-at': ms(OPEN_AT + TIMELINE.flashDelay),
    '--pc-flash': ms(TIMELINE.flash),
    '--pc-pop-at': ms(POP_AT),
    '--pc-pop': ms(TIMELINE.pop),
    '--pc-card-at': ms(CARD_AT),
    '--pc-card': ms(TIMELINE.card),
    '--pc-hint-at': ms(HINT_AT),
  }
}

/**
 * The launch splash: a 16-bit Poké Ball rolls in over a few tufts of grass, twitches twice and
 * opens on the third twitch with a burst of light; a Pokémon pops out and its Pokédex card fades
 * in. CSS keyframes only (splash.css), timed from config.js. Tapping, clicking, Escape, Enter or
 * Space skips it at any moment. `mode` 'still' is the Reduce Motion version: the revealed card,
 * without the roll, twitches or flash.
 */
export default function Splash({
  entry,
  spriteSrc,
  mode = 'full',
  speed = 1,
  autoContinueMs = AUTO_CONTINUE_MS,
  hold = false,
  t,
  language = 'en',
  onFinish,
}) {
  const still = mode === 'still'
  const [exiting, setExiting] = useState(null) // null | 'auto' | 'skip'
  const [revealed, setRevealed] = useState(still)
  const [announced, setAnnounced] = useState(false)
  const [spriteSize, setSpriteSize] = useState(null)
  const [spriteFailed, setSpriteFailed] = useState(false)
  const rootRef = useRef(null)
  const skipRef = useRef(null)
  const text = useMemo(() => splashText(entry, { t, language, unit: WEIGHT_UNIT }), [entry, t, language])
  const waitsForTap = hold || (!still && autoContinueMs == null)

  const close = useCallback(how => setExiting(current => current || how), [])

  useEffect(() => {
    skipRef.current?.focus({ preventScroll: true })
  }, [])

  // The reveal and auto-continue run on timers taken from the same constants as the CSS.
  useEffect(() => {
    if (exiting) return undefined
    const timers = []
    if (!still) timers.push(setTimeout(() => setRevealed(true), REVEAL_AT * speed))
    if (!waitsForTap) {
      const after = still ? REDUCED_MOTION_HOLD_MS : REVEAL_AT + autoContinueMs
      timers.push(setTimeout(() => close('auto'), after * speed))
    }
    return () => timers.forEach(clearTimeout)
  }, [still, speed, waitsForTap, autoContinueMs, exiting, close])

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

  // Pixel sprites are scaled by a whole number so their pixels stay square and sharp, and stand
  // on the grass however much transparent margin the file has.
  const measureSprite = event => {
    const image = event.currentTarget
    const pixel = parseFloat(getComputedStyle(rootRef.current).getPropertyValue('--px')) || 6
    setSpriteSize(fitSprite({
      width: image.naturalWidth,
      height: image.naturalHeight,
      bounds: measureBounds(image),
      target: (SPRITE_TARGET_PX * pixel) / 6,
    }))
  }

  const style = {
    ...timelineStyle(speed),
    '--pc-exit': `${exiting === 'skip' ? TIMELINE.skipFade : Math.round(TIMELINE.fadeOut * speed)}ms`,
    '--pc-type': typeColour(entry.types),
  }

  return (
    <div
      ref={rootRef}
      className={`pc-splash${still ? ' is-still' : ''}${exiting ? ' is-exiting' : ''}`}
      style={style}
      role="dialog"
      aria-modal="true"
      aria-label={t('splash.label')}
      data-testid="launch-splash"
      data-mode={mode}
      data-revealed={revealed ? 'true' : 'false'}
      onClick={() => close('skip')}
    >
      <div className="pc-splash__flash" aria-hidden="true" />
      <div className="pc-splash__scene" aria-hidden="true">
        <div className="pc-splash__aura" />
        <div className="pc-splash__pokemon">
          {spriteSrc && !spriteFailed && (
            <img
              className="pc-splash__sprite"
              src={spriteSrc}
              alt=""
              draggable="false"
              data-sized={spriteSize ? 'true' : undefined}
              style={spriteSize ?? undefined}
              onLoad={measureSprite}
              onError={() => setSpriteFailed(true)}
            />
          )}
        </div>
        <div className="pc-splash__ball">
          <div className="pc-splash__settle">
            <div className="pc-splash__twitch pc-splash__twitch--1">
              <div className="pc-splash__twitch pc-splash__twitch--2">
                <div className="pc-splash__twitch pc-splash__twitch--3">
                  <div className="pc-splash__spin">
                    <PixelArt art={BALL_LID} className="pc-splash__lid" />
                    <PixelArt art={BALL_BASE} className="pc-splash__base" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <PixelArt art={BURST} className="pc-splash__burst" />
        <PixelArt art={GRASS} className="pc-splash__grass" />
      </div>
      <div className="pc-splash__card" aria-hidden={revealed ? undefined : 'true'} data-testid="launch-splash-card">
        <p className="pc-splash__number"><span className="pc-splash__pip" aria-hidden="true" />{text.number}</p>
        <h2 className="pc-splash__name">{text.name}</h2>
        <p className="pc-splash__meta">{text.meta}</p>
        {text.fact && <p className="pc-splash__fact">{text.fact}</p>}
      </div>
      <p className="pc-splash__live" aria-live="polite">{announced ? text.announcement : ''}</p>
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
