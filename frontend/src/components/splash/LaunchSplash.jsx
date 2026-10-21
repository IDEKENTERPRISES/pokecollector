import { Component, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSettings } from '../../contexts/SettingsContext'
import { CHUNK_WAIT_MS, PREFETCH_DELAY_MS, TODAY_TIMEOUT_MS } from './config'
import { localDate, readDay, splashLanguage, starterEntry, takeFactTurn, writeDay } from './entryStore'
import { launchSplashMode, markLaunchSplashClosed } from './launch'
import { cacheSprite, fetchDay, prefetchDays, spriteSource } from './prefetch'

const PRELOAD_TIMEOUT_MS = 3000

// The animation, its art and its CSS load on their own, started the moment a launch decides to
// show the splash; the ball enters from off-screen, so a black cover is the same first frame.
const loadSplash = () => import('./Splash')
const Splash = lazy(loadSplash)
const COVER = { position: 'fixed', inset: 0, zIndex: 10000 /* --z-splash */, background: '#000' }

/** The black cover shown while the splash's code loads. It is never a dead end: a tap, click,
 * Escape, Enter or Space closes the splash, and so does CHUNK_WAIT_MS passing. It unmounts the
 * moment the splash renders, which also clears its timer and listeners. */
function LaunchCover({ onSkip }) {
  useEffect(() => {
    const timer = window.setTimeout(onSkip, CHUNK_WAIT_MS)
    const onKey = event => {
      if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') onSkip()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [onSkip])
  return <div style={COVER} data-testid="launch-cover" aria-hidden="true" onClick={onSkip} />
}

// A broken splash must never take the app down with it: it just closes.
class SplashBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch() {
    this.props.onError()
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}

function cachedLanguage() {
  try {
    return localStorage.getItem('app_language') || 'en'
  } catch {
    return 'en'
  }
}

/** Resolves once the image can be drawn (or failed, or took too long), so the reveal never
 * shows an empty space where a sprite is still downloading. */
function preload(src) {
  return new Promise(resolve => {
    const image = new Image()
    const done = () => resolve(src)
    const timer = setTimeout(done, PRELOAD_TIMEOUT_MS)
    image.onload = image.onerror = () => {
      clearTimeout(timer)
      done()
    }
    image.src = src
  })
}

/**
 * Shows the splash once per fresh launch (launch.js), above everything and while the app renders
 * underneath, so start-up is not delayed. Today's Pokémon comes from the device when it was
 * fetched ahead, else from the server while the ball rolls in; if it is not there in time the
 * starter comes out. While the splash is open the app is inert; afterwards focus goes back to the
 * app, and today's and tomorrow's Pokémon are fetched in the background.
 */
export default function LaunchSplash() {
  const { t, language } = useSettings()
  const [launch] = useState(() => {
    const mode = launchSplashMode()
    if (!mode) return null
    loadSplash()
    const today = localDate()
    return { mode, today, lang: splashLanguage(cachedLanguage()), stored: readDay(today), turn: takeFactTurn() }
  })
  const [showing, setShowing] = useState(Boolean(launch))
  const [entry, setEntry] = useState(launch?.stored ?? null)
  const [spriteSrc, setSpriteSrc] = useState(null)
  const languageRef = useRef(language)
  languageRef.current = language
  // Read during the first render, before the splash's own effect moves focus to Skip.
  const previousFocus = useRef(document.activeElement)

  useEffect(() => {
    if (!showing) return undefined
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    return () => {
      root?.removeAttribute('inert')
      const previous = previousFocus.current
      if (previous && previous !== document.body && previous.isConnected) previous.focus({ preventScroll: true })
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    }
  }, [showing])

  // Nothing fetched ahead for today: fetch it while the ball rolls in and twitches.
  useEffect(() => {
    if (!launch || launch.stored) return undefined
    let cancelled = false
    fetchDay(launch.today, { language: launch.lang, timeoutMs: TODAY_TIMEOUT_MS }).then(async fresh => {
      if (!fresh || cancelled) return
      await cacheSprite(fresh.sprite_url)
      writeDay(fresh)
      if (!cancelled) setEntry(current => current ?? fresh)
    })
    return () => {
      cancelled = true
    }
  }, [launch])

  // The sprite: a blob from the splash cache (works offline), else the server URL, loaded first.
  useEffect(() => {
    if (!entry) return undefined
    let cancelled = false
    let objectUrl = null
    setSpriteSrc(null)
    spriteSource(entry).then(preload).then(src => {
      if (src?.startsWith('blob:')) objectUrl = src
      if (cancelled) {
        if (objectUrl) URL.revokeObjectURL(objectUrl)
        return
      }
      setSpriteSrc(src)
    })
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [entry])

  const fallBackToStarter = useCallback(() => {
    setEntry(current => current ?? starterEntry(launch?.lang, launch?.today))
  }, [launch])

  const finish = useCallback(() => {
    markLaunchSplashClosed()
    setShowing(false)
    window.setTimeout(() => prefetchDays({ language: splashLanguage(languageRef.current) }), PREFETCH_DELAY_MS)
  }, [])

  if (!showing) return null
  return createPortal(
    <SplashBoundary onError={finish}>
      <Suspense fallback={<LaunchCover onSkip={finish} />}>
        <Splash
          entry={entry}
          spriteSrc={spriteSrc}
          factTurn={launch.turn}
          mode={launch.mode}
          t={t}
          language={language}
          onFinish={finish}
          onWaitTimeout={fallBackToStarter}
        />
      </Suspense>
    </SplashBoundary>,
    document.body,
  )
}
