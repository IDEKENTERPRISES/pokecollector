import { describe, expect, it } from 'vitest'
import { readLocalSeen, seenKey, writeLocalSeen } from './seen'

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v) }, data }
}

describe('the device copy of the seen id', () => {
  it('uses one key per account', () => {
    expect(seenKey(7)).toBe('pc.whatsNew.seen.7')
  })

  it('writes and reads back', () => {
    const storage = memoryStorage()
    expect(readLocalSeen(7, storage)).toBeNull()
    writeLocalSeen(7, '2026-10-30', storage)
    expect(storage.data['pc.whatsNew.seen.7']).toBe('2026-10-30')
    expect(readLocalSeen(7, storage)).toBe('2026-10-30')
    expect(readLocalSeen(8, storage)).toBeNull()
  })

  it('never throws when storage is blocked', () => {
    const blocked = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
    expect(readLocalSeen(7, blocked)).toBeNull()
    expect(() => writeLocalSeen(7, '2026-10-30', blocked)).not.toThrow()
    expect(readLocalSeen(7, null)).toBeNull()
  })
})
