import { describe, expect, it } from 'vitest'
import { MAX_DEX_ID, addToBag, decodeSeen, encodeSeen } from './shuffleBag.js'

describe('the shuffle bag', () => {
  it('round-trips any set of species', () => {
    const ids = [1, 8, 9, 25, 151, 649, 650, 1024, 1025]
    const encoded = encodeSeen(ids)
    expect(encoded).toHaveLength(172)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect([...decodeSeen(encoded)].sort((a, b) => a - b)).toEqual(ids)
  })

  it('uses the bit order the server decodes', () => {
    // backend/tests/test_pokedex_splash.py: species 1 and 9 start with "AQE".
    expect(encodeSeen([1, 9]).slice(0, 3)).toBe('AQE')
    expect(encodeSeen([]).replace(/A/g, '')).toBe('')
  })

  it('ignores numbers outside the National Pokédex', () => {
    expect(decodeSeen(encodeSeen([0, -3, 1026, 2.5, 'x', 7]))).toEqual(new Set([7]))
  })

  it('reads anything unreadable as an empty bag', () => {
    expect(decodeSeen('')).toEqual(new Set())
    expect(decodeSeen(null)).toEqual(new Set())
    expect(decodeSeen('%%%')).toEqual(new Set())
  })

  it('collects species until every one has appeared, then starts again', () => {
    let bag = ''
    for (let id = 1; id < MAX_DEX_ID; id += 1) bag = addToBag(bag, id)
    expect(decodeSeen(bag).size).toBe(MAX_DEX_ID - 1)
    bag = addToBag(bag, MAX_DEX_ID)
    // Full: a fresh bag holding only the last one, so it is not picked again straight away.
    expect(decodeSeen(bag)).toEqual(new Set([MAX_DEX_ID]))
  })

  it('adding a species twice changes nothing', () => {
    const once = addToBag('', 25)
    expect(addToBag(once, 25)).toBe(once)
  })
})
