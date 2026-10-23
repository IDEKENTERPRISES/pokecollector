// Optional small card pictures per language, kept in the picture store (pictureStore.js, F16a): one
// IndexedDB Blob per set plus an index, which the service worker's image route slices, so the
// pictures show offline everywhere. (Until F16a they were one Cache Storage entry each, in
// PICTURE_CACHE_PREFIX caches; those are only migrated away now, see pictureMigration.js.)
//
// One request per set (F14b): the server sends a set's pictures as one "pack" that is stored as it
// is. Pictures the server could not include are fetched singly. Progress is saved per set, so a
// stopped download continues with the next unfinished set, also after an app restart.

import { PictureError, retrying, sleepMs, statusError, timed } from './net.js'
import { AbortedError } from './sync.js'

export const PICTURE_CACHE_PREFIX = 'pc-carddb-images-v1-'
export const RECORD_PREFIX = 'pc-carddb-pictures-v1-'
/** The pre-F16a Cache Storage cache of a language (only migrated away). */
export const pictureCacheName = lang => `${PICTURE_CACHE_PREFIX}${lang}`
/** A rough average for the size estimate shown before downloading (a small card is about 20 KB). */
export const AVERAGE_PICTURE_BYTES = 20 * 1024
export const PACK_CONCURRENCY = 3
export const SINGLE_CONCURRENCY = 4
export const PACK_TIMEOUT_MS = 60 * 1000
export const SINGLE_TIMEOUT_MS = 15 * 1000
/** A download with no sign of life (bytes, a picture saved, a set finished) for this long is stalled. */
export const STALL_MS = 35 * 1000

export const cardPictureUrl = cardId => `/api/images/card/${encodeURIComponent(cardId)}/small`
export const setPictureUrl = (setId, type) => `/api/images/set/${encodeURIComponent(setId)}/${type}`
export const packPath = (lang, setId) => `/api/offline/carddb/pictures/${encodeURIComponent(lang)}/${encodeURIComponent(setId)}`

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

// ── Pack format (backend/services/card_picture_packs.py) ─────────────────────

/** `[4-byte length][JSON {items:[{id,o,l,t}], missing:[id]}][bytes]` → `{ items: [{id, type, bytes}], missing }`. */
export function parsePack(buffer) {
  const view = new DataView(buffer)
  const size = view.getUint32(0)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, size)))
  const start = 4 + size
  return {
    items: header.items.map(item => ({ id: item.id, type: item.t, bytes: new Uint8Array(buffer, start + item.o, item.l) })),
    missing: header.missing ?? [],
  }
}

// ── Progress saved per set ───────────────────────────────────────────────────

/** `{ sets: { [setId]: { bytes, skipped } } }` per language in localStorage (its own key, not the card store). */
export function createPictureRecord(storage, lang) {
  const key = `${RECORD_PREFIX}${lang}`
  let data = { sets: {} }
  try {
    const parsed = JSON.parse(storage?.getItem(key) || 'null')
    if (parsed && typeof parsed.sets === 'object') data = parsed
  } catch {
    // unreadable: start over, the store check below finds what is already saved
  }
  const save = () => {
    try {
      storage?.setItem(key, JSON.stringify(data))
    } catch {
      // a full storage only means the next resume re-checks the store
    }
  }
  return {
    isDone: setId => Boolean(data.sets[setId]),
    markDone(setId, { bytes = 0, skipped = 0 } = {}) {
      data.sets[setId] = { bytes, skipped }
      save()
    },
    doneCount: () => Object.keys(data.sets).length,
    bytes: () => Object.values(data.sets).reduce((sum, item) => sum + (item.bytes || 0), 0),
    skipped: () => Object.values(data.sets).reduce((sum, item) => sum + (item.skipped || 0), 0),
    clear() {
      data = { sets: {} }
      try {
        storage?.removeItem(key)
      } catch {
        // nothing to do
      }
    },
  }
}

// ── Downloading ──────────────────────────────────────────────────────────────

const contentTypeOf = response => (response?.headers?.get?.('Content-Type') || '').toLowerCase()

// A redirect is the server's "card back" stand-in for a picture it could not fetch; never keep it.
const isStorableImage = response => Boolean(response)
  && response.status === 200
  && !response.redirected
  && contentTypeOf(response).startsWith('image/')

const allKnown = (urls, known) => urls.every(url => known.has(url))

async function storing(work) {
  try {
    return await work()
  } catch (error) {
    // Quota exceeded or similar: stop, what was saved stays.
    throw new PictureError('storage', error?.message || 'storage')
  }
}

const pathOfCard = id => cardPictureUrl(id)

/** Fetches one picture the pack did not carry. Returns the bytes stored, or null when the server refused this picture. */
async function downloadSingle({ url, lang, store, known, fetchImage, signal, timeoutMs, retries, sleep, touch }) {
  return retrying(() => timed(async inner => {
    let response
    try {
      response = await fetchImage(url, inner)
    } catch (error) {
      if (inner.aborted) throw error
      throw new PictureError('network', error?.message || 'network')
    }
    touch()
    if (response?.status >= 500 || response?.status === 429) throw statusError(response.status)
    if (!isStorableImage(response)) return null // a refusal for this one picture: skip it
    const blob = typeof response.blob === 'function' ? await response.blob() : null
    touch()
    if (!blob) return null
    await storing(() => store.putLoose({ lang, path: url, blob, type: contentTypeOf(response) }))
    known.add(url)
    return blob.size
  }, timeoutMs, signal), { attempts: retries, signal, sleep })
}

async function runPool(items, concurrency, signal, worker) {
  const queue = items.slice()
  const inner = new AbortController()
  const onAbort = () => inner.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  let failure = null
  const lane = async () => {
    while (queue.length && !failure) {
      if (signal?.aborted) return
      const item = queue.shift()
      try {
        await worker(item, inner.signal)
      } catch (error) {
        if (!failure) failure = error
        inner.abort() // stop the other lanes' requests now; nothing may keep running after we return
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane))
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  if (signal?.aborted) throw new AbortedError()
  if (failure) throw failure
}

/**
 * Downloads the pictures of the sets that are not marked done in `record`.
 *  - `lang` and `sets`: the language and its stored set payloads.
 *  - `fetchPack(path, signal)` → `{ status, buffer }`; rejects on a network failure, throws statusError for
 *    5xx/429/401. Status 404/403 means "no packs here": the set's pictures are fetched singly.
 *  - `fetchImage(url, signal)` → a Response.
 *  - `onProgress({ doneSets, totalSets, bytes })` after every finished set; `bytes` counts this run only.
 * Throws AbortedError when paused or cancelled and PictureError (an OfflineError) when a request kept
 * failing after its retries or the device cannot store more; finished sets stay saved.
 */
export async function downloadPictures({
  lang, sets, store, fetchPack, fetchImage, record, signal, onProgress = () => {}, sleep = sleepMs,
  concurrency = PACK_CONCURRENCY, singleConcurrency = SINGLE_CONCURRENCY,
  packTimeoutMs = PACK_TIMEOUT_MS, singleTimeoutMs = SINGLE_TIMEOUT_MS, retries = 3, onActivity = () => {},
}) {
  const touch = () => onActivity()
  const totalSets = sets.length
  let doneSets = sets.filter(payload => record.isDone(payload?.set?.id)).length
  let bytes = 0
  onProgress({ doneSets, totalSets, bytes })
  const todo = sets.filter(payload => payload?.set?.id && !record.isDone(payload.set.id))
  const known = todo.length ? await storing(() => store.knownPaths(pathOfCard)) : new Set()

  await runPool(todo, concurrency, signal, async (payload, laneSignal) => {
    const setId = payload.set.id
    const urls = pictureUrlsFor([payload])
    let setBytes = 0
    let skipped = 0
    if (!allKnown(urls, known)) {
      let wanted = urls
      const pack = await retrying(() => timed(async inner => {
        let response
        try {
          response = await fetchPack(packPath(lang, setId), inner, touch)
        } catch (error) {
          if (inner.aborted || error?.status) throw error
          throw new PictureError('network', error?.message || 'network')
        }
        return response
      }, packTimeoutMs, laneSignal), { attempts: retries, signal: laneSignal, sleep })
      touch()
      if (pack.status === 200 && pack.buffer) {
        const parsed = parsePack(pack.buffer)
        // The whole pack is the Blob; each picture is a slice of it, found through the index.
        const items = parsed.items.map(item => ({ id: item.id, offset: item.bytes.byteOffset, length: item.bytes.byteLength, type: item.type }))
        await storing(() => store.putPack({ lang, setId, blob: new Blob([pack.buffer]), items }))
        for (const item of items) known.add(cardPictureUrl(item.id))
        touch()
        setBytes += pack.buffer.byteLength
        bytes += pack.buffer.byteLength
        const have = new Set(parsed.items.map(item => cardPictureUrl(item.id)))
        wanted = urls.filter(url => !have.has(url))
      }
      // The pictures the pack did not carry (and the set's logo and symbol) one by one.
      const singles = wanted.filter(url => !known.has(url))
      await runPool(singles, singleConcurrency, laneSignal, async url => {
        const stored = await downloadSingle({ url, lang, store, known, fetchImage, signal: laneSignal, timeoutMs: singleTimeoutMs, retries, sleep, touch })
        if (stored === null) skipped += 1
        setBytes += stored ?? 0
        bytes += stored ?? 0
      })
    }
    record.markDone(setId, { bytes: setBytes, skipped })
    doneSets += 1
    touch()
    onProgress({ doneSets, totalSets, bytes })
  })
  return { doneSets, totalSets, bytes }
}

/**
 * Marks sets whose pictures are all stored already (an earlier download, or one from before progress was
 * saved) and returns `{ doneSets, totalSets, remainingUrls }` without downloading anything.
 */
export async function inspectPictureSets({ sets, store, record }) {
  let doneSets = 0
  let remainingUrls = 0
  // A store that cannot be opened (no IndexedDB) reads as "nothing downloaded".
  const known = store ? await store.knownPaths(pathOfCard).catch(() => null) : null
  for (const payload of sets) {
    const setId = payload?.set?.id
    if (!setId) continue
    const urls = pictureUrlsFor([payload])
    if (record.isDone(setId)) doneSets += 1
    else if (known && urls.length && allKnown(urls, known)) {
      record.markDone(setId, { bytes: 0, skipped: 0 })
      doneSets += 1
    } else remainingUrls += urls.length
  }
  return { doneSets, totalSets: sets.length, remainingUrls }
}
