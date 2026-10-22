// Optional small card pictures per language, kept in their own Cache Storage cache (not the
// service worker's 800-image one). The worker's image route also looks in these caches, so the
// pictures show offline everywhere. Throttled (about 4 at once) because the server may fetch
// uncached images from TCGdex. Resumable: what is already cached is skipped.

import { AbortedError, OfflineError } from './sync.js'

export const PICTURE_CACHE_PREFIX = 'pc-carddb-images-v1-'
export const pictureCacheName = lang => `${PICTURE_CACHE_PREFIX}${lang}`
/** A rough average for the size estimate shown before downloading (a small card is about 20 KB). */
export const AVERAGE_PICTURE_BYTES = 20 * 1024
export const PICTURE_CONCURRENCY = 4

export const cardPictureUrl = cardId => `/api/images/card/${encodeURIComponent(cardId)}/small`
export const setPictureUrl = (setId, type) => `/api/images/set/${encodeURIComponent(setId)}/${type}`

/** Every picture URL a language needs, from its stored sets: set logos and symbols, then small cards. */
export function pictureUrlsFor(setPayloads) {
  const urls = []
  for (const payload of setPayloads) {
    const setId = payload?.set?.id
    if (setId) {
      if (payload.set.images_logo) urls.push(setPictureUrl(setId, 'logo'))
      if (payload.set.images_symbol) urls.push(setPictureUrl(setId, 'symbol'))
    }
    const idIndex = payload?.fields?.indexOf('id') ?? -1
    const smallIndex = payload?.fields?.indexOf('images_small') ?? -1
    for (const row of payload?.cards ?? []) {
      // Cards without a catalogue picture would only be served the card back; skip them.
      if (idIndex >= 0 && (smallIndex < 0 || row[smallIndex])) urls.push(cardPictureUrl(row[idIndex]))
    }
  }
  return urls
}

export const estimatePictureBytes = count => count * AVERAGE_PICTURE_BYTES

const isStorableImage = response => Boolean(response)
  && response.status === 200
  && (response.headers?.get('Content-Type') || '').toLowerCase().startsWith('image/')

/**
 * Downloads the pictures that are not cached yet. `cache` is a Cache Storage cache, `fetchImage(url, signal)`
 * resolves a Response and rejects on a network failure. Calls `onProgress({ done, total })` as
 * pictures finish (cached ones count as done at once). Throws AbortedError when paused or cancelled and
 * OfflineError on a network failure; a single picture the server refuses is skipped, not fatal.
 */
export async function downloadPictures({ urls, cache, fetchImage, signal, concurrency = PICTURE_CONCURRENCY, onProgress = () => {} }) {
  const total = urls.length
  const queue = []
  let done = 0
  for (const url of urls) {
    if (await cache.match(url)) done += 1
    else queue.push(url)
  }
  onProgress({ done, total })

  const lane = async () => {
    while (queue.length) {
      if (signal?.aborted) throw new AbortedError()
      const url = queue.shift()
      let response
      try {
        response = await fetchImage(url, signal)
      } catch (error) {
        if (signal?.aborted) throw new AbortedError()
        throw new OfflineError(error?.message || 'network')
      }
      if (isStorableImage(response)) {
        try {
          await cache.put(url, response)
        } catch (error) {
          // Quota exceeded or similar: stop, what was saved stays.
          throw new OfflineError(error?.message || 'storage')
        }
      }
      done += 1
      onProgress({ done, total })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, lane))
  if (signal?.aborted) throw new AbortedError()
  return { done, total }
}

/** Counts how many of `urls` are cached already (for "N of M" without downloading). */
export async function countCachedPictures(urls, cache) {
  let count = 0
  for (const url of urls) if (await cache.match(url)) count += 1
  return count
}
