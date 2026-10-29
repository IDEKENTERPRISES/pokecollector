import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useParams } from 'react-router-dom'
import { useHideValues } from '../components/ios/hideValues'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import { fill } from '../delights/delights'
import { useBack } from '../navigation/useBack'
import { readShowDaily } from '../progress/daily'
import PokeBallLoader from '../components/PokeBallLoader'
import { StageContext, loadDisplayFont } from './pieces'
import SharePicker from './SharePicker'
import { DARK_INK, STAGE_H, STAGE_W } from './theme'
import Slide, { slideInk } from './WrappedSlides'
import { useWrapped } from './useWrapped'
import { parseYear, selectSlides, wrappedMoney, wrappedYearFor } from './wrapped'
import './wrapped.css'

const SWIPE_DOWN_PX = 80
const HOLD_MS = 350

/**
 * The Wrapped story (engagement P9b, redesigned in P9c): a full-screen story at /wrapped/:year. Tap
 * the right two-thirds to go forward, the left third to go back; swipe down or the close button
 * leaves. Slides advance by themselves after about six seconds (the progress segment is a CSS
 * animation, and its end moves the story on), pausing while a finger is down. With Reduce Motion the
 * animation, the slide fade and the count-ups are off, so nothing moves on its own. The Previous and
 * Next areas are real buttons.
 *
 * Every slide is laid out on the mockups' 390 × 844 stage, scaled to fit the screen (on a 390 × 844
 * iPhone it is 1:1), and its background fills the rest of the screen.
 */
// Rendered into the body: the shell's tab bar lives outside the page's own stacking context.
export default function WrappedStory() {
  return createPortal(<Story />, document.body)
}

/** The scale that fits the 390 × 844 stage on screen, and where the stage sits in the scaled world. */
function useStage() {
  const read = () => ({
    width: (typeof window !== 'undefined' && window.innerWidth) || STAGE_W,
    height: (typeof window !== 'undefined' && window.innerHeight) || STAGE_H,
  })
  const [box, setBox] = useState(read)
  useLayoutEffect(() => {
    const measure = () => setBox(current => {
      const next = read()
      return next.width === current.width && next.height === current.height ? current : next
    })
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  const scale = Math.min(box.width / STAGE_W, box.height / STAGE_H) || 1
  const worldW = box.width / scale
  const worldH = box.height / scale
  return { scale, worldW, worldH, offX: (worldW - STAGE_W) / 2, offY: (worldH - STAGE_H) / 2 }
}

function Story() {
  const { year: param } = useParams()
  const year = parseYear(param, wrappedYearFor())
  const { t, language, currencySymbol, exchangeRate } = useSettings()
  const { user } = useAuth()
  const { hidden } = useHideValues()
  const back = useBack()
  const { data, isPending } = useWrapped(year)
  const showDaily = readShowDaily()
  const slides = useMemo(() => selectSlides(data, { showDaily }), [data, showDaily])
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [sharing, setSharing] = useState(false)
  const gesture = useRef({ x: 0, y: 0, at: 0, swiped: false })
  const stage = useStage()
  // The mockups read "12 March"; a bare "en" would format as "March 12".
  const locale = language === 'en' ? 'en-GB' : (language || undefined)
  const name = user?.display_name || user?.username || ''
  const last = slides.length - 1
  const at = Math.min(index, Math.max(0, last))

  useEffect(() => { loadDisplayFont() }, [])

  const next = useCallback(() => setIndex(i => Math.min(last, i + 1)), [last])
  const prev = useCallback(() => setIndex(i => Math.max(0, i - 1)), [])

  useEffect(() => {
    if (sharing) return undefined
    const onKey = event => {
      if (event.key === 'ArrowRight') next()
      else if (event.key === 'ArrowLeft') prev()
      else if (event.key === 'Escape') back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, prev, back, sharing])

  const money = useMemo(() => wrappedMoney({ symbol: currencySymbol || '€', rate: exchangeRate || 1, hidden }), [currencySymbol, exchangeRate, hidden])

  const onPointerDown = event => {
    gesture.current = { x: event.clientX, y: event.clientY, at: Date.now(), swiped: false }
    setPaused(true)
  }
  const onPointerEnd = event => {
    setPaused(false)
    const g = gesture.current
    const dy = event.clientY - g.y
    if (event.type === 'pointerup' && dy > SWIPE_DOWN_PX && dy > Math.abs(event.clientX - g.x) * 1.5) {
      g.swiped = true
      back()
    }
  }
  // A swipe or a long press is not a tap: the click that follows it must not turn the page.
  const tap = go => () => {
    const g = gesture.current
    if (g.swiped || (g.at && Date.now() - g.at > HOLD_MS)) {
      g.swiped = false
      return
    }
    go()
  }

  if (isPending && !data) {
    return (
      <div className="fixed inset-0 z-[1000] grid place-items-center bg-black text-white"><PokeBallLoader /></div>
    )
  }
  if (!data || slides.length === 0) {
    return (
      <div className="fixed inset-0 z-[1000] flex flex-col items-center justify-center gap-4 bg-black px-8 text-center text-white" data-testid="wrapped-unavailable">
        <p className="m-0 text-[20px] font-bold">{t('wrapped.unavailable')}</p>
        <button type="button" onClick={back} className="min-h-[48px] rounded-full bg-white/15 px-6 text-[16px] font-semibold">{t('wrapped.close')}</button>
      </div>
    )
  }

  const id = slides[at]
  const isLast = at === last
  const ink = slideInk(id, data)
  const track = ink === DARK_INK ? 'rgba(29,22,0,0.25)' : 'rgba(255,255,255,0.35)'
  const ctx = {
    data, t, locale, name, money, hidden, showDaily, n: at + 1, total: slides.length,
    onShare: () => setSharing(true), onRestart: () => setIndex(0),
  }
  const { offX, offY, worldW, worldH, scale } = stage
  // On the summary the tap areas stop above the buttons (y 630 on the stage).
  const zoneBottom = isLast ? worldH - (offY + 630) : 0

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={fill(t('wrapped.dialog'), { year: data.year })}
      data-testid="wrapped-story"
      data-slide={id}
      className="fixed inset-0 z-[1000] select-none overflow-hidden bg-black text-white"
      style={{ touchAction: 'pan-x' }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <div data-testid="wrapped-world" style={{ position: 'absolute', left: 0, top: 0, width: worldW, height: worldH, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
        <StageContext.Provider value={{ offX, offY }}>
          <div
            key={id}
            role="group"
            aria-roledescription="slide"
            aria-label={fill(t('wrapped.slideOf'), { n: at + 1, count: slides.length })}
            aria-live="polite"
            className="wrapped-slide"
            style={{ position: 'absolute', inset: 0, zIndex: 1 }}
          >
            <Slide id={id} ctx={ctx} />
          </div>

          <button
            type="button"
            onClick={tap(prev)}
            disabled={at === 0}
            aria-label={t('wrapped.previous')}
            data-testid="wrapped-prev"
            style={{ position: 'absolute', left: 0, top: offY + 106, bottom: zoneBottom, width: '34%', zIndex: 2, border: 0, background: 'transparent' }}
          />
          <button
            type="button"
            onClick={tap(next)}
            disabled={isLast}
            aria-label={t('wrapped.next')}
            data-testid="wrapped-next"
            style={{ position: 'absolute', right: 0, top: offY + 106, bottom: zoneBottom, width: '66%', zIndex: 2, border: 0, background: 'transparent' }}
          />

          <div style={{ position: 'absolute', left: offX, top: offY, width: STAGE_W, height: 0, zIndex: 3 }}>
            <div aria-hidden="true" style={{ position: 'absolute', left: 10, right: 10, top: 54, display: 'grid', gridTemplateColumns: `repeat(${slides.length}, minmax(0, 1fr))`, gap: 4 }}>
              {slides.map((slide, k) => (
                <div key={slide} style={{ height: 3, borderRadius: 2, overflow: 'hidden', background: track }}>
                  {k <= at && (
                    <div
                      key={k === at ? `run-${at}` : slide}
                      data-testid={k === at ? 'wrapped-progress' : undefined}
                      className={k === at && !isLast ? 'wrapped-fill' : undefined}
                      style={{ height: '100%', width: '100%', background: ink, ...(k === at && paused ? { animationPlayState: 'paused' } : null) }}
                      onAnimationEnd={k === at ? next : undefined}
                    />
                  )}
                </div>
              ))}
            </div>
            <button type="button" onClick={back} aria-label={t('wrapped.close')} data-testid="wrapped-close" style={{
              position: 'absolute', right: 6, top: 62, width: 44, height: 44, border: 0, borderRadius: 22, background: 'transparent',
              color: ink, display: 'grid', placeItems: 'center', padding: 0, cursor: 'pointer',
            }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </div>
        </StageContext.Provider>
      </div>
      {sharing && <SharePicker source={{ data, t, locale, name, money, showDaily }} onClose={() => setSharing(false)} />}
    </div>
  )
}
