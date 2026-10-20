import { beforeEach, describe, expect, it } from 'vitest'
import { emptyTabMemory, resolveTabPress, tabMemoryReducer } from './tabMemory.js'

const visit = (state, pathname, search = '') => tabMemoryReducer(state, { type: 'VISIT', pathname, search })

describe('tabMemoryReducer', () => {
  let state
  beforeEach(() => { state = emptyTabMemory })

  it('remembers the last location of a tab, with its search', () => {
    state = visit(state, '/collection', '?type=Fire')
    state = visit(state, '/binders/7')
    expect(state.last.collection).toBe('/binders/7')
    expect(state.lastRoot.collection).toBe('/collection')
  })

  it('remembers Collection\'s segment root: whichever segment was open last', () => {
    state = visit(state, '/collection')
    state = visit(state, '/wishlist')
    state = visit(state, '/binders/7')
    expect(state.lastRoot.collection).toBe('/wishlist')
  })

  it('files /collection/user/:id under Profile', () => {
    state = visit(state, '/collection/user/3')
    expect(state.last.profile).toBe('/collection/user/3')
    expect(state.last.collection).toBeUndefined()
  })

  it('ignores the scan inbox and unknown paths', () => {
    state = visit(state, '/scans')
    state = visit(state, '/nowhere')
    expect(state).toEqual(emptyTabMemory)
  })
})

describe('resolveTabPress', () => {
  it('restores the last location when switching to another tab', () => {
    let state = visit(emptyTabMemory, '/binders/7')
    state = visit(state, '/search')
    expect(resolveTabPress(state, 'collection', '/search')).toEqual({ type: 'navigate', to: '/binders/7' })
  })

  it('falls back to the tab root when the tab was never visited', () => {
    expect(resolveTabPress(emptyTabMemory, 'profile', '/')).toEqual({ type: 'navigate', to: '/profile' })
    expect(resolveTabPress(emptyTabMemory, 'home', '/search')).toEqual({ type: 'navigate', to: '/' })
  })

  it('re-tapping a tab on a pushed page returns to its root', () => {
    let state = visit(emptyTabMemory, '/binders')
    state = visit(state, '/binders/7')
    expect(resolveTabPress(state, 'collection', '/binders/7')).toEqual({ type: 'navigate', to: '/binders' })
  })

  it('re-tapping at the root scrolls to the top', () => {
    const state = visit(emptyTabMemory, '/search')
    expect(resolveTabPress(state, 'search', '/search')).toEqual({ type: 'scrollTop' })
  })

  it('treats Profile\'s pushed pages as depth', () => {
    const state = visit(emptyTabMemory, '/settings/appearance')
    expect(resolveTabPress(state, 'profile', '/settings/appearance')).toEqual({ type: 'navigate', to: '/profile' })
  })

  it('switches from the scan inbox like from any other tab', () => {
    const state = visit(emptyTabMemory, '/collection')
    expect(resolveTabPress(state, 'collection', '/scans')).toEqual({ type: 'navigate', to: '/collection' })
  })

  it('does nothing for an unknown tab', () => {
    expect(resolveTabPress(emptyTabMemory, 'nope', '/')).toEqual({ type: 'none' })
  })
})
