import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const effects = []
vi.mock('react', () => ({ useEffect: fn => effects.push(fn) }))
vi.mock('../pwa/push', () => ({ getCurrentSubscription: vi.fn() }))

const { getCurrentSubscription } = await import('../pwa/push')
const { HEARTBEAT_INTERVAL_MS, startPresence } = await import('../pwa/presence')
const { usePresenceHeartbeat } = await import('./usePresenceHeartbeat')

function fakeTarget() {
  const listeners = {}
  return {
    visibilityState: 'visible',
    listeners,
    addEventListener: (type, fn) => { (listeners[type] ||= new Set()).add(fn) },
    removeEventListener: (type, fn) => { listeners[type]?.delete(fn) },
    fire: (type) => listeners[type]?.forEach(fn => fn()),
  }
}

const bodies = () => globalThis.fetch.mock.calls.map(([, init]) => JSON.parse(init.body).state)
const flush = () => vi.advanceTimersByTimeAsync(0)

describe('presence heartbeat', () => {
  let doc
  let win
  beforeEach(() => {
    vi.useFakeTimers()
    doc = fakeTarget()
    win = fakeTarget()
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true }))
    getCurrentSubscription.mockResolvedValue({ endpoint: 'https://web.push.apple.com/abc' })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    effects.length = 0
  })

  it('reports foreground at once when visible, then every 30 s', async () => {
    startPresence(doc, win)
    await flush()
    expect(bodies()).toEqual(['foreground'])
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    expect(bodies()).toEqual(['foreground', 'foreground', 'foreground'])
    const init = globalThis.fetch.mock.calls[0][1]
    expect(init.keepalive).toBe(true)
    expect(JSON.parse(init.body).endpoint).toBe('https://web.push.apple.com/abc')
  })

  it('reports background and stops the interval when the page is hidden', async () => {
    startPresence(doc, win)
    await flush()
    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    await flush()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3)
    expect(bodies()).toEqual(['foreground', 'background'])
  })

  it('starts again when the page becomes visible', async () => {
    doc.visibilityState = 'hidden'
    startPresence(doc, win)
    await flush()
    expect(bodies()).toEqual([])
    doc.visibilityState = 'visible'
    doc.fire('visibilitychange')
    await flush()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    expect(bodies()).toEqual(['foreground', 'foreground'])
  })

  it('reports background on pagehide and beforeunload', async () => {
    startPresence(doc, win)
    await flush()
    win.fire('pagehide')
    win.fire('beforeunload')
    await flush()
    expect(bodies()).toEqual(['foreground', 'background', 'background'])
  })

  it('sends nothing when this device has no push subscription', async () => {
    getCurrentSubscription.mockResolvedValue(null)
    startPresence(doc, win)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('stop removes the listeners and the interval', async () => {
    const stop = startPresence(doc, win)
    await flush()
    stop()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2)
    doc.fire('visibilitychange')
    win.fire('pagehide')
    await flush()
    expect(bodies()).toEqual(['foreground'])
  })

  it('the hook starts it on mount and its cleanup stops it', async () => {
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', win)
    usePresenceHeartbeat()
    const stop = effects[0]()
    await flush()
    expect(bodies()).toEqual(['foreground'])
    stop()
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS)
    expect(bodies()).toEqual(['foreground'])
  })
})
