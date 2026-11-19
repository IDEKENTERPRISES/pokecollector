import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ROUTE_CHUNK_TABLE,
  chunkLoaderFor,
  isRouteReady,
  preloadRoute,
  resetRoutePreloadForTests,
  whenRouteReady,
} from './routePreload'

describe('routePreload', () => {
  let loader
  let chunks

  beforeEach(() => {
    resetRoutePreloadForTests()
    loader = vi.fn(() => Promise.resolve({}))
    chunks = [[/^\/settings(\/|$)/, loader]]
  })

  it('maps real pushed paths to a chunk', () => {
    expect(chunkLoaderFor('/settings/about', ROUTE_CHUNK_TABLE)).toBeTypeOf('function')
    expect(chunkLoaderFor('/sets/sv1_ja', ROUTE_CHUNK_TABLE)).toBeTypeOf('function')
    expect(chunkLoaderFor('/nope', ROUTE_CHUNK_TABLE)).toBeNull()
  })

  it('fetches once however often it is asked, and is then ready', async () => {
    expect(isRouteReady('/settings', chunks)).toBe(false)
    await Promise.all([preloadRoute('/settings', chunks), preloadRoute({ pathname: '/settings/x' }, chunks)])
    expect(loader).toHaveBeenCalledTimes(1)
    expect(isRouteReady('/settings?a=1', chunks)).toBe(true)
  })

  it('treats a route with no chunk as ready', () => {
    expect(isRouteReady('/elsewhere', chunks)).toBe(true)
  })

  it('may try again after a failed fetch and never rejects', async () => {
    loader.mockRejectedValueOnce(new Error('offline'))
    await expect(preloadRoute('/settings', chunks)).resolves.toBeUndefined()
    expect(isRouteReady('/settings', chunks)).toBe(false)
    await preloadRoute('/settings', chunks)
    expect(loader).toHaveBeenCalledTimes(2)
    expect(isRouteReady('/settings', chunks)).toBe(true)
  })

  it('stops waiting after the limit when the chunk is slow', async () => {
    vi.useFakeTimers()
    try {
      chunks = [[/^\/settings/, () => new Promise(() => {})]]
      let done = false
      whenRouteReady('/settings', 400, chunks).then(() => { done = true })
      await vi.advanceTimersByTimeAsync(399)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(2)
      expect(done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
