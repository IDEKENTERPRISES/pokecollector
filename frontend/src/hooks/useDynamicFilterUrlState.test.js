import { describe, expect, it } from 'vitest'

import { consumePendingUrlKey } from './useDynamicFilterUrlState'

describe('consumePendingUrlKey', () => {
  it('treats a queued URL as our own and keeps later pending writes', () => {
    // "d" then "dr" typed before the router rendered the first URL.
    expect(consumePendingUrlKey(['q=d', 'q=dr'], 'q=d')).toEqual({ own: true, pending: ['q=dr'] })
    expect(consumePendingUrlKey(['q=dr'], 'q=dr')).toEqual({ own: true, pending: [] })
  })
  it('treats an unknown URL as external and clears the queue', () => {
    expect(consumePendingUrlKey(['q=d'], 'q=other')).toEqual({ own: false, pending: [] })
  })
})
