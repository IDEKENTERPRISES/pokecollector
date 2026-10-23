import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AUTO_CONTINUE_MS,
  CARD_AT,
  OPEN_AT,
  REVEAL_AT,
  TIMELINE,
} from './config.js'
import {
  ENABLED_KEY,
  SUPPRESS_KEY,
  consumeSplashSuppression,
  whenLaunchSplashClosed,
  isSplashPath,
  launchSplashMode,
  markLaunchSplashClosed,
  readSplashEnabled,
  resetLaunchForTests,
  splashMode,
  suppressNextSplash,
  writeSplashEnabled,
} from './launch.js'

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    values,
  }
}

const broken = {
  getItem: () => { throw new Error('blocked') },
  setItem: () => { throw new Error('blocked') },
  removeItem: () => { throw new Error('blocked') },
}

describe('the toggle', () => {
  it('is on by default and per device', () => {
    expect(readSplashEnabled(memoryStorage())).toBe(true)
    expect(readSplashEnabled(memoryStorage({ [ENABLED_KEY]: '1' }))).toBe(true)
    expect(readSplashEnabled(memoryStorage({ [ENABLED_KEY]: '0' }))).toBe(false)
  })

  it('round-trips and survives blocked storage', () => {
    const storage = memoryStorage()
    writeSplashEnabled(false, storage)
    expect(storage.values.get(ENABLED_KEY)).toBe('0')
    expect(readSplashEnabled(storage)).toBe(false)
    writeSplashEnabled(true, storage)
    expect(readSplashEnabled(storage)).toBe(true)
    expect(readSplashEnabled(broken)).toBe(true)
    expect(() => writeSplashEnabled(false, broken)).not.toThrow()
  })
})

describe('the update-reload suppression', () => {
  it('suppresses exactly one launch', () => {
    const session = memoryStorage()
    expect(consumeSplashSuppression(session)).toBe(false)
    suppressNextSplash(session)
    expect(session.values.get(SUPPRESS_KEY)).toBe('1')
    expect(consumeSplashSuppression(session)).toBe(true)
    expect(consumeSplashSuppression(session)).toBe(false)
  })

  it('never throws without sessionStorage', () => {
    expect(() => suppressNextSplash(broken)).not.toThrow()
    expect(consumeSplashSuppression(broken)).toBe(false)
    expect(consumeSplashSuppression(null)).toBe(false)
  })
})

describe('where it shows', () => {
  it('skips public pages, invite links and DEV galleries', () => {
    for (const path of ['/', '/collection', '/login', '/settings/appearance', '/users', '/upgrade', '/offline']) {
      expect(isSplashPath(path), path).toBe(true)
    }
    for (const path of ['/u', '/u/', '/u/ash', '/u/ash/binder/2', '/invite/abc', '/__splash', '/__ios']) {
      expect(isSplashPath(path), path).toBe(false)
    }
  })
})

describe('splashMode', () => {
  it('plays the full animation on a normal fresh launch', () => {
    expect(splashMode({ pathname: '/' })).toBe('full')
  })

  it('respects the toggle, the reload suppression and the route', () => {
    expect(splashMode({ enabled: false })).toBeNull()
    expect(splashMode({ suppressed: true })).toBeNull()
    expect(splashMode({ pathname: '/u/ash' })).toBeNull()
  })

  it('stays out of automated browsers unless a test opts in', () => {
    expect(splashMode({ automated: true })).toBeNull()
    expect(splashMode({ automated: true, optedIn: true })).toBe('full')
  })

  it('can be limited to the Home Screen app', () => {
    expect(splashMode({ showIn: 'standalone', standalone: false })).toBeNull()
    expect(splashMode({ showIn: 'standalone', standalone: true })).toBe('full')
  })

  it('shows the still card, or nothing, under Reduce Motion', () => {
    expect(splashMode({ reducedMotion: true })).toBe('still')
    expect(splashMode({ reducedMotion: true, reducedMotionMode: 'off' })).toBeNull()
  })
})

describe('launch detection', () => {
  afterEach(() => resetLaunchForTests())

  it('decides once per document, so navigation and remounts never bring it back', () => {
    let reads = 0
    const env = () => {
      reads += 1
      return reads === 1 ? { pathname: '/' } : { enabled: false }
    }
    expect(launchSplashMode(env)).toBe('full')
    expect(launchSplashMode(env)).toBe('full')
    expect(reads).toBe(1)
  })

  it('stays closed once it has closed', () => {
    expect(launchSplashMode({ pathname: '/' })).toBe('full')
    markLaunchSplashClosed()
    expect(launchSplashMode({ pathname: '/' })).toBeNull()
  })

  it('a launch that started without the splash never shows it later', () => {
    expect(launchSplashMode({ pathname: '/u/ash' })).toBeNull()
    expect(launchSplashMode({ pathname: '/' })).toBeNull()
  })
})

describe('the timeline', () => {
  it('opens on the third twitch, reveals within three seconds and leaves six seconds to read', () => {
    const thirdTwitch = TIMELINE.firstTwitchAt + 2 * (TIMELINE.twitch + TIMELINE.twitchGap)
    expect(OPEN_AT).toBeGreaterThan(thirdTwitch)
    expect(OPEN_AT).toBeLessThan(thirdTwitch + TIMELINE.twitch)
    expect(TIMELINE.firstTwitchAt).toBeGreaterThan(TIMELINE.roll + TIMELINE.settle)
    expect(CARD_AT).toBeGreaterThan(REVEAL_AT)
    expect(REVEAL_AT).toBeLessThan(3000)
    // The owner's answer: the app opens by itself 6 s after the reveal (about 9 s in all).
    expect(AUTO_CONTINUE_MS).toBe(6000)
    expect(REVEAL_AT + AUTO_CONTINUE_MS + TIMELINE.fadeOut).toBeLessThan(10000)
  })
})

describe('whenLaunchSplashClosed', () => {
  afterEach(() => resetLaunchForTests())

  it('resolves at once when this launch has no splash', async () => {
    launchSplashMode({ pathname: '/u/ash' })
    await expect(whenLaunchSplashClosed(5000)).resolves.toBeUndefined()
  })

  it('waits for the splash to close, or for the limit', async () => {
    vi.useFakeTimers()
    launchSplashMode({ pathname: '/' })
    let done = false
    whenLaunchSplashClosed(5000).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(done).toBe(false)
    markLaunchSplashClosed()
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)

    resetLaunchForTests()
    launchSplashMode({ pathname: '/' })
    done = false
    whenLaunchSplashClosed(5000).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(done).toBe(true)
    vi.useRealTimers()
  })
})
