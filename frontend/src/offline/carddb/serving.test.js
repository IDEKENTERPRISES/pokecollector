import { describe, expect, it } from 'vitest'
import { pageHasNoSavedData } from '../notSaved.js'
import { isSavableKey } from '../readCache.js'
import { CARDDB_QUERY_KEY } from './useCatalogQuery.jsx'

describe('card database answers stay apart from server data', () => {
  it('never reaches the read cache, whatever follows the key', () => {
    expect(CARDDB_QUERY_KEY).toBe('carddb')
    expect(isSavableKey([CARDDB_QUERY_KEY, 'sets', 'en'])).toBe(false)
    expect(isSavableKey(['sets', 'en'])).toBe(true)
  })

  it('does not count towards the "not saved yet" line', () => {
    const missing = { queryKey: ['set-checklist', 'x'], state: { data: undefined } }
    const fromDb = { queryKey: [CARDDB_QUERY_KEY, 'set-checklist', 'x'], state: { data: undefined } }
    expect(pageHasNoSavedData([missing, fromDb])).toBe(true)
    expect(pageHasNoSavedData([fromDb])).toBe(false)
  })
})
