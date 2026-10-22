import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { cancelHungQueries, createOfflineEpisodes, refreshAfterReconnect } from './offlineEpisode'

describe('createOfflineEpisodes', () => {
  it('starts once when the banner comes up and ends once when it goes', () => {
    const episodes = createOfflineEpisodes()
    expect(episodes.update(false)).toBeNull()
    expect(episodes.update(true)).toBe('start')
    expect(episodes.update(true)).toBeNull()
    expect(episodes.update(true)).toBeNull()
    expect(episodes.isOffline()).toBe(true)
    expect(episodes.update(false)).toBe('end')
    expect(episodes.update(false)).toBeNull()
    expect(episodes.isOffline()).toBe(false)
  })

  it('a second offline episode starts again', () => {
    const episodes = createOfflineEpisodes()
    expect([true, false, true].map(value => episodes.update(value))).toEqual(['start', 'end', 'start'])
  })

  it('treats a start-up already offline as a start', () => {
    expect(createOfflineEpisodes().update(true)).toBe('start')
  })
})

describe('cancelHungQueries', () => {
  const never = () => new Promise(() => {})

  it('cancels fetches that are in flight with nothing to show, and only those', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.fetchQuery({ queryKey: ['collection'], queryFn: never }).catch(() => {})
    client.setQueryData(['wishlist'], ['kept'])
    client.fetchQuery({ queryKey: ['wishlist'], queryFn: never, staleTime: 0 }).catch(() => {})
    await Promise.resolve()

    const hungBefore = client.getQueryState(['collection'])
    expect(hungBefore.fetchStatus).toBe('fetching')
    expect(cancelHungQueries(client)).toBe(1)
    await Promise.resolve()

    const hung = client.getQueryState(['collection'])
    expect(hung.fetchStatus).toBe('idle')
    expect(hung.status).toBe('pending')
    expect(hung.data).toBeUndefined()
    // A query that already shows data keeps its fetch.
    expect(client.getQueryState(['wishlist']).fetchStatus).toBe('fetching')
  })

  it('does nothing when nothing is hanging', () => {
    const client = new QueryClient()
    client.setQueryData(['collection'], ['x'])
    expect(cancelHungQueries(client)).toBe(0)
  })
})

describe('refreshAfterReconnect', () => {
  it('asks every active query again', () => {
    const invalidateQueries = vi.fn().mockResolvedValue()
    refreshAfterReconnect({ invalidateQueries })
    expect(invalidateQueries).toHaveBeenCalledWith({ type: 'active' })
  })
})
