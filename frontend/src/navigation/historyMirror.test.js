import { describe, expect, it } from 'vitest'
import { MAX_ENTRIES, currentEntry, emptyHistory, historyReducer, previousEntry } from './historyMirror.js'

const push = (state, key, path) => historyReducer(state, { type: 'PUSH', key, path })
const replace = (state, key, path) => historyReducer(state, { type: 'REPLACE', key, path })
const pop = (state, key, path) => historyReducer(state, { type: 'POP', key, path })

describe('historyReducer', () => {
  it('starts a mirror from the first POP (the initial load, an unknown key)', () => {
    const state = pop(emptyHistory, 'a', '/collection')
    expect(state.entries).toEqual([{ key: 'a', path: '/collection', section: 'collection' }])
    expect(state.index).toBe(0)
  })

  it('PUSH appends and records the section', () => {
    let state = pop(emptyHistory, 'a', '/collection')
    state = push(state, 'b', '/binders/7')
    expect(state.index).toBe(1)
    expect(currentEntry(state)).toEqual({ key: 'b', path: '/binders/7', section: 'collection' })
    expect(previousEntry(state).path).toBe('/collection')
  })

  it('PUSH drops the entries after the current index', () => {
    let state = pop(emptyHistory, 'a', '/')
    state = push(state, 'b', '/search')
    state = push(state, 'c', '/sets')
    state = pop(state, 'b', '/search')
    state = push(state, 'd', '/pokedex')
    expect(state.entries.map(e => e.key)).toEqual(['a', 'b', 'd'])
    expect(state.index).toBe(2)
  })

  it('REPLACE overwrites the current entry', () => {
    let state = pop(emptyHistory, 'a', '/collection')
    state = replace(state, 'b', '/binders')
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]).toEqual({ key: 'b', path: '/binders', section: 'collection' })
  })

  it('REPLACE on an empty mirror starts it', () => {
    const state = replace(emptyHistory, 'a', '/')
    expect(state.index).toBe(0)
  })

  it('POP to a known key moves the index and keeps the entries', () => {
    let state = pop(emptyHistory, 'a', '/')
    state = push(state, 'b', '/search')
    state = push(state, 'c', '/sets')
    state = pop(state, 'a', '/')
    expect(state.index).toBe(0)
    expect(state.entries).toHaveLength(3)
    state = pop(state, 'c', '/sets')
    expect(state.index).toBe(2)
  })

  it('POP to an unknown key (after a reload) resets to the current location', () => {
    let state = pop(emptyHistory, 'a', '/')
    state = push(state, 'b', '/search')
    state = pop(state, 'zzz', '/profile')
    expect(state.entries).toEqual([{ key: 'zzz', path: '/profile', section: 'profile' }])
    expect(state.index).toBe(0)
  })

  it('caps the mirror at 50 entries and keeps the index on the newest', () => {
    let state = pop(emptyHistory, 'k0', '/')
    for (let i = 1; i < MAX_ENTRIES + 20; i += 1) state = push(state, `k${i}`, i % 2 ? '/search' : '/')
    expect(state.entries).toHaveLength(MAX_ENTRIES)
    expect(state.index).toBe(MAX_ENTRIES - 1)
    expect(currentEntry(state).key).toBe(`k${MAX_ENTRIES + 19}`)
    expect(state.entries[0].key).toBe('k20')
  })

  it('has no previous entry at the start', () => {
    expect(previousEntry(pop(emptyHistory, 'a', '/'))).toBeNull()
    expect(previousEntry(emptyHistory)).toBeNull()
  })

  it('ignores unknown actions', () => {
    const state = pop(emptyHistory, 'a', '/')
    expect(historyReducer(state, { type: 'NOPE', key: 'x', path: '/' })).toBe(state)
  })
})
