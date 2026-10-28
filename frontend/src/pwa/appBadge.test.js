import { describe, expect, it } from 'vitest'
import { setAppBadge } from './appBadge'

const fakeNav = () => {
  const log = []
  return { log, setAppBadge: async n => { log.push(['set', n]) }, clearAppBadge: async () => { log.push(['clear']) } }
}

describe('setAppBadge', () => {
  it('sets a positive count and clears at zero or for invalid counts', async () => {
    const nav = fakeNav()
    await setAppBadge(4, nav)
    await setAppBadge(0, nav)
    await setAppBadge(undefined, nav)
    await setAppBadge(-2, nav)
    expect(nav.log).toEqual([['set', 4], ['clear'], ['clear'], ['clear']])
  })

  it('does nothing when the API is missing or rejects', async () => {
    expect(await setAppBadge(3, undefined)).toBe(false)
    expect(await setAppBadge(3, {})).toBe(false)
    expect(await setAppBadge(3, { setAppBadge: async () => { throw new Error('denied') } })).toBe(false)
    expect(await setAppBadge(3, { setAppBadge: () => { throw new Error('sync') } })).toBe(false)
  })
})
