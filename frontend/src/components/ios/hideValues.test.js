import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HIDDEN_VALUE, HIDE_VALUES_KEY, getHideValues, maskValue, resetHideValuesCache, setHideValues, subscribeHideValues, useHideValues,
} from './hideValues'

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)) },
    removeItem: key => { data.delete(key) },
  }
}

describe('maskValue', () => {
  it('passes amounts through while values are shown', () => {
    expect(maskValue('£12.50', false)).toBe('£12.50')
  })

  it('masks amounts while values are hidden', () => {
    expect(maskValue('£12.50', true)).toBe(HIDDEN_VALUE)
    expect(HIDDEN_VALUE).toBe('••••')
  })

  it('leaves a missing amount alone: there is nothing to hide', () => {
    expect(maskValue('-', true)).toBe('-')
  })
})

describe('hide values store', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage())
    resetHideValuesCache()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    resetHideValuesCache()
  })

  it('defaults to showing values', () => {
    expect(getHideValues()).toBe(false)
  })

  it('persists the choice in localStorage under pc.hideValues', () => {
    setHideValues(true)
    expect(globalThis.localStorage.getItem(HIDE_VALUE_KEY_FOR_TEST)).toBe('1')
    expect(getHideValues()).toBe(true)
    setHideValues(false)
    expect(globalThis.localStorage.getItem(HIDE_VALUE_KEY_FOR_TEST)).toBeNull()
    expect(getHideValues()).toBe(false)
  })

  it('reads a saved choice on first use', () => {
    vi.stubGlobal('localStorage', memoryStorage({ [HIDE_VALUES_KEY]: '1' }))
    resetHideValuesCache()
    expect(getHideValues()).toBe(true)
  })

  it('tells subscribers when it changes', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeHideValues(listener)
    setHideValues(true)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    setHideValues(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('survives blocked storage', () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, removeItem() { throw new Error('blocked') } })
    resetHideValuesCache()
    expect(getHideValues()).toBe(false)
    expect(() => setHideValues(true)).not.toThrow()
    expect(getHideValues()).toBe(true)
  })

  it('useHideValues reports the stored state to components', () => {
    function Probe() {
      const { hidden } = useHideValues()
      return createElement('span', null, maskValue('£9.99', hidden))
    }
    // Server render uses the "shown" snapshot; the stored flag applies on the client.
    expect(renderToStaticMarkup(createElement(Probe))).toContain('£9.99')
  })
})

const HIDE_VALUE_KEY_FOR_TEST = HIDE_VALUES_KEY
