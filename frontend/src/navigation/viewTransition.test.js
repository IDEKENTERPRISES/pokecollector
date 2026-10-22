import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-dom', () => ({ flushSync: fn => fn() }))

const {
  SLIDE_TRANSITIONS,
  isPlainClick,
  notifyLocationCommitted,
  runViewTransition,
  viewTransitionsEnabled,
} = await import('./viewTransition')

function fakeDoc({ supported = true } = {}) {
  const doc = {
    documentElement: { dataset: {} },
    started: 0,
    callbacks: [],
  }
  if (supported) {
    doc.startViewTransition = callback => {
      doc.started += 1
      const done = Promise.resolve(callback())
      doc.callbacks.push(done)
      return { finished: done }
    }
  }
  return doc
}

const win = (reduced = false) => ({
  matchMedia: () => ({ matches: reduced }),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
})

describe('viewTransitionsEnabled', () => {
  it('needs the switch, platform support and allowed motion', () => {
    expect(SLIDE_TRANSITIONS).toBe(true)
    expect(viewTransitionsEnabled({ doc: fakeDoc(), win: win() })).toBe(true)
    expect(viewTransitionsEnabled({ doc: fakeDoc({ supported: false }), win: win() })).toBe(false)
    expect(viewTransitionsEnabled({ doc: fakeDoc(), win: win(true) })).toBe(false)
  })
})

describe('runViewTransition', () => {
  let update
  beforeEach(() => { update = vi.fn() })

  it('just runs the navigation without support', () => {
    const doc = fakeDoc({ supported: false })
    expect(runViewTransition(update, { doc, win: win() })).toBeNull()
    expect(update).toHaveBeenCalledTimes(1)
    expect(doc.documentElement.dataset.vt).toBeUndefined()
  })

  it('just runs the navigation under reduced motion', () => {
    const doc = fakeDoc()
    expect(runViewTransition(update, { doc, win: win(true) })).toBeNull()
    expect(update).toHaveBeenCalledTimes(1)
    expect(doc.started).toBe(0)
  })

  it('runs the navigation inside a transition with the direction on the root, then clears it', async () => {
    const doc = fakeDoc()
    const transition = runViewTransition(update, { doc, direction: 'back', win: win() })
    expect(doc.started).toBe(1)
    expect(doc.documentElement.dataset.vt).toBe('back')
    expect(update).toHaveBeenCalledTimes(1)
    notifyLocationCommitted()
    await transition.finished
    await Promise.resolve()
    expect(doc.documentElement.dataset.vt).toBeUndefined()
  })

  it('waits for the commit, and does not freeze if it never comes', async () => {
    vi.useFakeTimers()
    try {
      const doc = fakeDoc()
      let settled = false
      const transition = runViewTransition(update, { doc, win: { matchMedia: () => ({ matches: false }), setTimeout: (fn, ms) => setTimeout(fn, ms) } })
      transition.finished.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(100)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(800)
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips a transition that runs on, so the page takes taps again', async () => {
    vi.useFakeTimers()
    try {
      const doc = fakeDoc()
      const skipTransition = vi.fn()
      const slow = new Promise(() => {})
      doc.startViewTransition = () => ({ finished: slow, skipTransition })
      runViewTransition(update, { doc, win: { matchMedia: () => ({ matches: false }), setTimeout: (fn, ms) => setTimeout(fn, ms) } })
      await vi.advanceTimersByTimeAsync(1400)
      expect(skipTransition).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(200)
      expect(skipTransition).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to a plain navigation if the browser throws', () => {
    const doc = fakeDoc()
    doc.startViewTransition = () => { throw new Error('nope') }
    expect(runViewTransition(update, { doc, win: win() })).toBeNull()
    expect(update).toHaveBeenCalledTimes(1)
    expect(doc.documentElement.dataset.vt).toBeUndefined()
  })
})

describe('isPlainClick', () => {
  const click = overrides => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...overrides })

  it('accepts a plain left click only', () => {
    expect(isPlainClick(click())).toBe(true)
    expect(isPlainClick(click({ metaKey: true }))).toBe(false)
    expect(isPlainClick(click({ ctrlKey: true }))).toBe(false)
    expect(isPlainClick(click({ button: 1 }))).toBe(false)
    expect(isPlainClick(click({ defaultPrevented: true }))).toBe(false)
  })
})
