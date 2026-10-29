import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { X } from 'lucide-react'
import { maskValue, useHideValues } from '../components/ios/hideValues'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import { fill } from '../delights/delights'
import { useBack } from '../navigation/useBack'
import { readShowDaily } from '../progress/daily'
import { currentAccent, currentFont, renderBlocksImage, sharePicture } from '../progress/shareImage'
import PokeBallLoader from '../components/PokeBallLoader'
import Slide from './WrappedSlides'
import { useWrapped } from './useWrapped'
import { WRAPPED_SHARE_FILE, parseYear, selectSlides, wrappedShareSpec, wrappedYearFor } from './wrapped'

const SWIPE_DOWN_PX = 80
const HOLD_MS = 350

/**
 * The Wrapped story (engagement P9b): a full-screen story at /wrapped/:year. Tap the right two-thirds
 * to go forward, the left third to go back; swipe down or the close button leaves. Slides advance by
 * themselves after about six seconds (the progress segment is a CSS animation, and its end moves the
 * story on), pausing while a finger is down. With Reduce Motion the animation and the slide fade are
 * off, so nothing moves on its own. The Previous and Next areas are real buttons.
 */
// Rendered into the body: the shell's tab bar lives outside the page's own stacking context.
export default function WrappedStory() {
  return createPortal(<Story />, document.body)
}

function Story() {
  const { year: param } = useParams()
  const year = parseYear(param, wrappedYearFor())
  const { t, formatPrice, language } = useSettings()
  const { user } = useAuth()
  const { hidden } = useHideValues()
  const back = useBack()
  const { data, isPending } = useWrapped(year)
  const showDaily = readShowDaily()
  const slides = useMemo(() => selectSlides(data, { showDaily }), [data, showDaily])
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const gesture = useRef({ x: 0, y: 0, at: 0, swiped: false })
  const picture = useRef(null)
  // The mockups read "12 March"; a bare "en" would format as "March 12".
  const locale = language === 'en' ? 'en-GB' : (language || undefined)
  const name = user?.display_name || user?.username || ''
  const last = slides.length - 1
  const at = Math.min(index, Math.max(0, last))

  const next = useCallback(() => setIndex(i => Math.min(last, i + 1)), [last])
  const prev = useCallback(() => setIndex(i => Math.max(0, i - 1)), [])

  useEffect(() => {
    const onKey = event => {
      if (event.key === 'ArrowRight') next()
      else if (event.key === 'ArrowLeft') prev()
      else if (event.key === 'Escape') back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, prev, back])

  const money = amount => maskValue(formatPrice(amount), hidden)
  const build = () => renderBlocksImage(wrappedShareSpec({
    data, t, money: formatPrice, locale, showDaily, hideValues: hidden, name,
    accent: currentAccent(), fontFamily: currentFont(),
  }))
  // Draw on touch-down, so the share sheet opens inside the tap that follows.
  const prepare = () => { picture.current = picture.current || build() }
  const share = async () => {
    try {
      const blob = await (picture.current || build())
      picture.current = null
      if (!blob) {
        toast.error(t('wrapped.shareFailed'))
        return
      }
      if (await sharePicture(blob, { name: WRAPPED_SHARE_FILE }) === 'downloaded') toast.success(t('wrapped.shareDownloaded'))
    } catch {
      toast.error(t('wrapped.shareFailed'))
    }
  }

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
  const ctx = {
    data, t, locale, name, money, showDaily,
    onShare: share, onPrepare: prepare, onRestart: () => setIndex(0),
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={fill(t('wrapped.dialog'), { year: data.year })}
      data-testid="wrapped-story"
      data-slide={id}
      className="fixed inset-0 z-[1000] select-none overflow-hidden bg-black text-white"
      style={{ touchAction: 'pan-x', fontFamily: 'inherit' }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <div
        key={id}
        role="group"
        aria-roledescription="slide"
        aria-label={fill(t('wrapped.slideOf'), { n: at + 1, count: slides.length })}
        aria-live="polite"
        className="wrapped-slide absolute inset-0 z-[1]"
      >
        <Slide id={id} ctx={ctx} />
      </div>

      <button
        type="button"
        onClick={tap(prev)}
        disabled={at === 0}
        aria-label={t('wrapped.previous')}
        data-testid="wrapped-prev"
        className="absolute left-0 top-[72px] z-[2] w-[34%] border-0 bg-transparent"
        style={{ bottom: isLast ? 180 : 0 }}
      />
      <button
        type="button"
        onClick={tap(next)}
        disabled={isLast}
        aria-label={t('wrapped.next')}
        data-testid="wrapped-next"
        className="absolute right-0 top-[72px] z-[2] w-[66%] border-0 bg-transparent"
        style={{ bottom: isLast ? 180 : 0 }}
      />

      <div aria-hidden="true" className="absolute inset-x-3 z-[3] flex gap-1" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 14px)' }}>
        {slides.map((slide, k) => (
          <div key={slide} className="h-[3px] flex-1 overflow-hidden rounded-sm bg-white/30">
            {k <= at && (
              <div
                key={k === at ? `run-${at}` : slide}
                data-testid={k === at ? 'wrapped-progress' : undefined}
                className={`h-full w-full bg-white ${k === at && !isLast ? 'wrapped-fill' : ''}`}
                style={k === at && paused ? { animationPlayState: 'paused' } : undefined}
                onAnimationEnd={k === at ? next : undefined}
              />
            )}
          </div>
        ))}
      </div>
      <div className="absolute left-5 right-1.5 z-[3] flex items-center justify-between" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 24px)' }}>
        <p className="m-0 text-[15px] font-bold">
          {fill(t('wrapped.headerTitle'), { year: data.year })}
          <span className="font-medium opacity-75"> · {fill(t('wrapped.slideOf'), { n: at + 1, count: slides.length })}</span>
        </p>
        <button type="button" onClick={back} aria-label={t('wrapped.close')} data-testid="wrapped-close" className="grid h-11 w-11 place-items-center border-0 bg-transparent text-white">
          <X size={22} strokeWidth={2.5} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
