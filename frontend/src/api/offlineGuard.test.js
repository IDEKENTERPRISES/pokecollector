/**
 * While the app is offline, a request that changes something is refused at once with a short message
 * (owner feedback F12): no spinner that never ends, no silent failure. Reads are not touched, and the
 * outbox replays with `fetch`, so the queued actions are not affected either.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = { request: null, responseOk: null, responseError: null }

vi.mock('axios', () => ({
  default: {
    create: () => ({
      interceptors: {
        request: { use: fn => { handlers.request = fn } },
        response: { use: (ok, error) => { handlers.responseOk = ok; handlers.responseError = error } },
      },
    }),
    isCancel: () => false,
  },
}))

await import('./client')
const { DEFAULT_OFFLINE_MESSAGE, setOfflineMessage, setOfflineStatus } = await import('../offline/offlineStatus')

const configOf = method => ({ method, url: '/x', headers: {} })

describe('the API client while offline', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
    setOfflineMessage(DEFAULT_OFFLINE_MESSAGE)
    setOfflineStatus(false)
  })
  afterEach(() => {
    setOfflineStatus(false)
    vi.unstubAllGlobals()
  })

  it('lets every request through while online', () => {
    for (const method of ['get', 'post', 'put', 'delete']) {
      const config = configOf(method)
      expect(handlers.request(config)).toBe(config)
    }
  })

  it('refuses changes at once while the banner is up, with the message as the server-style detail', async () => {
    setOfflineStatus(true)
    for (const method of ['post', 'put', 'patch', 'delete', 'POST']) {
      const rejected = handlers.request(configOf(method))
      await expect(rejected).rejects.toMatchObject({
        isOfflineRefusal: true,
        message: DEFAULT_OFFLINE_MESSAGE,
        response: { status: 0, data: { detail: DEFAULT_OFFLINE_MESSAGE } },
      })
    }
  })

  it('lets reads through while offline (they are served from the saved copy or wait)', () => {
    setOfflineStatus(true)
    for (const method of ['get', 'head', 'options', undefined]) {
      const config = configOf(method)
      expect(handlers.request(config)).toBe(config)
    }
  })

  it('refuses a change when only the device says it is offline', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    await expect(handlers.request(configOf('post'))).rejects.toMatchObject({ isOfflineRefusal: true })
  })

  it('uses the translated message the app sets, and an opted-in request still goes through', async () => {
    setOfflineStatus(true)
    setOfflineMessage('Braucht eine Verbindung.')
    await expect(handlers.request(configOf('post'))).rejects.toMatchObject({ response: { data: { detail: 'Braucht eine Verbindung.' } } })
    const allowed = { ...configOf('post'), allowOffline: true }
    expect(handlers.request(allowed)).toBe(allowed)
  })

  it('the refusal does not look like a dead connection, so it never feeds the reachability monitor', async () => {
    setOfflineStatus(true)
    const error = await handlers.request(configOf('post')).catch(caught => caught)
    // The response interceptor only hints the monitor when there is no response at all.
    await expect(handlers.responseError(error)).rejects.toBe(error)
    expect(error.response).toBeTruthy()
  })
})
