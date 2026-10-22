import { describe, expect, it } from 'vitest'
import { SHELL_QUERY_KEYS, pageHasNoSavedData } from './notSaved'

const query = (key, data) => ({ queryKey: [key], state: { data } })

describe('pageHasNoSavedData', () => {
  it('is true when the page has queries and none holds data', () => {
    expect(pageHasNoSavedData([query('sets', undefined), query('binders', undefined)])).toBe(true)
  })

  it('is true when at least half of the queries of a page hold no data, even if one is shared with a saved page', () => {
    expect(pageHasNoSavedData([query('sets', undefined), query('binders', [])])).toBe(true)
    expect(pageHasNoSavedData([query('dashboard', {}), query('duplicates', undefined), query('top-movers', undefined), query('rarity-stats', undefined)])).toBe(true)
  })

  it('is false when most of the page is saved (a saved copy or fresh data)', () => {
    expect(pageHasNoSavedData([query('collection', ['x'])])).toBe(false)
    expect(pageHasNoSavedData([query('collection', ['x']), query('wishlist', []), query('binders', [])])).toBe(false)
    expect(pageHasNoSavedData([query('collection', ['x']), query('wishlist', []), query('binders', []), query('sets', undefined)])).toBe(false)
  })

  it('ignores the shell\'s own queries (scan badge, sync status, small settings)', () => {
    for (const key of SHELL_QUERY_KEYS) {
      expect(pageHasNoSavedData([query(key, undefined)]), key).toBe(false)
    }
    expect(pageHasNoSavedData([query('scan-jobs', ['job']), query('sets', undefined)])).toBe(true)
    expect(pageHasNoSavedData([query('scan-jobs', undefined), query('sets', ['x'])])).toBe(false)
    expect(pageHasNoSavedData([query('scan-jobs', ['job']), query('sets', undefined), query('binders', undefined)])).toBe(true)
  })

  it('is false for a page with no queries of its own', () => {
    expect(pageHasNoSavedData([])).toBe(false)
    expect(pageHasNoSavedData([query('scan-jobs', undefined)])).toBe(false)
  })
})
