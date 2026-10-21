import { Component, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSettings } from '../../contexts/SettingsContext'
import Splash from './Splash'
import { PREFETCH_DELAY_MS } from './config'
import { markShown, pickLaunchEntry, readNextEntry } from './entryStore'
import { launchSplashMode, markLaunchSplashClosed } from './launch'
import { prefetchNextEntry, spriteSource } from './prefetch'

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

/**
 * Shows the splash once per fresh launch (launch.js), above everything and while the app renders
 * underneath, so start-up is not delayed. While it is open the app is inert; afterwards focus
 * goes back to the app and the next launch's Pokémon is fetched in the background.
 */
export default function LaunchSplash() {
  const { t, language } = useSettings()
  const [launch, setLaunch] = useState(() => {
    const mode = launchSplashMode()
    return mode ? { mode, entry: pickLaunchEntry({ next: readNextEntry(), language: cachedLanguage() }) } : null
  })
  const [spriteSrc, setSpriteSrc] = useState(null)
  const languageRef = useRef(language)
  languageRef.current = language
  // Read during the first render, before the splash's own effect moves focus to Skip.
  const previousFocus = useRef(document.activeElement)

  useEffect(() => {
    if (!launch) return undefined
    markShown(launch.entry.dex_id)
    const root = document.getElementById('root')
    root?.setAttribute('inert', '')
    return () => {
      root?.removeAttribute('inert')
      const previous = previousFocus.current
      if (previous && previous !== document.body && previous.isConnected) previous.focus({ preventScroll: true })
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    }
  }, [launch])

  useEffect(() => {
    if (!launch) return undefined
    let cancelled = false
    let objectUrl = null
    spriteSource(launch.entry).then(src => {
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
  }, [launch])

  const finish = useCallback(() => {
    markLaunchSplashClosed()
    setLaunch(null)
    window.setTimeout(() => prefetchNextEntry({ language: languageRef.current }), PREFETCH_DELAY_MS)
  }, [])

  if (!launch) return null
  return createPortal(
    <SplashBoundary onError={finish}>
      <Splash entry={launch.entry} spriteSrc={spriteSrc} mode={launch.mode} t={t} language={language} onFinish={finish} />
    </SplashBoundary>,
    document.body,
  )
}
