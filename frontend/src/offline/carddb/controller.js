// The offline card database's state machine (F13): per-device preferences, the sync run, the
// optional pictures download, and a snapshot for the UI. Browser pieces (IndexedDB store, fetch,
// Cache Storage, localStorage) are injected so it can be tested without a browser.

import {
  PICTURE_CACHE_PREFIX,
  countCachedPictures,
  downloadPictures,
  estimatePictureBytes,
  pictureCacheName,
  pictureUrlsFor,
} from './pictures.js'
import { AbortedError, OfflineError, runCardDbSync } from './sync.js'

export const PREFS_KEY = 'pc-carddb-prefs'
export const SYNC_THROTTLE_MS = 60 * 1000
const RETRY_STATUSES = new Set([429, 502, 503, 504])

/** Card data is on by default (design: F13 decision 5); languages are on unless switched off; pictures are off. */
export function readPrefs(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(PREFS_KEY) || '{}')
    return {
      enabled: parsed.enabled !== false,
      languages: parsed.languages && typeof parsed.languages === 'object' ? parsed.languages : {},
      pictures: parsed.pictures && typeof parsed.pictures === 'object' ? parsed.pictures : {},
    }
  } catch {
    return { enabled: true, languages: {}, pictures: {} }
  }
}

export function writePrefs(prefs, storage = globalThis.localStorage) {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // preferences are a convenience; a full or blocked storage just means defaults next time
  }
}

export const wantedLanguages = (prefs, available) => (prefs.enabled ? available.filter(lang => prefs.languages[lang] !== false) : [])

/** A JSON fetch with the signed-in token, for the card-database endpoints (no app-wide interceptors). */
export function createFetchJson({ fetchImpl = globalThis.fetch?.bind(globalThis), getToken = () => globalThis.localStorage?.getItem('token'), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  return async function fetchJson(path, signal) {
    for (let attempt = 0; ; attempt += 1) {
      let response
      try {
        const token = getToken()
        response = await fetchImpl(path, {
          signal,
          cache: 'no-cache',
          headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        })
      } catch (error) {
        if (signal?.aborted) throw new AbortedError()
        throw error // no status: a network failure
      }
      if (RETRY_STATUSES.has(response.status) && attempt < 3) {
        const wait = Number(response.headers.get('Retry-After'))
        await sleep(Number.isFinite(wait) && wait > 0 ? Math.min(wait, 30) * 1000 : 2000 * (attempt + 1))
        continue
      }
      if (response.status === 404 || response.status === 403) return { status: response.status }
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      const etag = (response.headers.get('ETag') || '').replace(/^W\//, '').replace(/"/g, '') || null
      return { status: response.status, data: await response.json(), etag }
    }
  }
}

const initialSnapshot = () => ({
  serverEnabled: null, // null until the first manifest answer
  available: [],
  status: 'idle', // idle | checking | downloading | offline | error
  progress: null,
  languages: {},
  prefs: { enabled: true, languages: {}, pictures: {} },
  storageOk: true,
  error: null,
})

export function createCardDbController({
  store,
  fetchJson,
  fetchImage = (url, signal) => globalThis.fetch(url, { signal }),
  openCache = name => globalThis.caches?.open(name),
  deleteCache = name => globalThis.caches?.delete(name),
  listCaches = () => globalThis.caches?.keys() ?? Promise.resolve([]),
  storage = globalThis.localStorage,
  isOnline = () => globalThis.navigator?.onLine !== false,
  requestPersist = () => globalThis.navigator?.storage?.persist?.(),
  now = Date.now,
} = {}) {
  let snapshot = { ...initialSnapshot(), prefs: readPrefs(storage) }
  const listeners = new Set()
  let running = null
  let lastRunAt = 0
  let persistAsked = false
  let syncAbort = null
  const pictureAborts = new Map()

  const emit = patch => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }
  const setPicture = (lang, patch) => emit({
    languages: { ...snapshot.languages, [lang]: { ...snapshot.languages[lang], pictures: { ...snapshot.languages[lang]?.pictures, ...patch } } },
  })
  const savePrefs = prefs => {
    writePrefs(prefs, storage)
    emit({ prefs })
  }

  async function refreshLanguages() {
    const languages = {}
    for (const lang of new Set([...snapshot.available, ...(await store.listLanguages())])) {
      const meta = await store.getMeta(lang)
      languages[lang] = {
        meta,
        bytes: meta ? await store.usage(lang) : 0,
        pictures: snapshot.languages[lang]?.pictures ?? { status: 'none' },
      }
    }
    emit({ languages })
  }

  async function sync({ force = false } = {}) {
    if (running) return running
    if (!force && now() - lastRunAt < SYNC_THROTTLE_MS) return null
    if (!isOnline()) {
      emit({ status: 'offline' })
      return null
    }
    running = (async () => {
      lastRunAt = now()
      syncAbort = new AbortController()
      emit({ status: 'checking', error: null, progress: null })
      try {
        if (!(await store.available())) {
          emit({ status: 'error', storageOk: false, error: 'storage' })
          return
        }
        emit({ storageOk: true })
        const result = await runCardDbSync({
          wantedLanguages: available => wantedLanguages(snapshot.prefs, available),
          store,
          fetchJson,
          signal: syncAbort.signal,
          onProgress: progress => emit({ status: 'downloading', progress }),
        })
        if (result.status === 'disabled') {
          emit({ serverEnabled: false, status: 'idle', progress: null, available: [], languages: {} })
          return
        }
        if (!persistAsked) {
          persistAsked = true
          try {
            await requestPersist()
          } catch {
            // best effort
          }
        }
        emit({ serverEnabled: true, available: result.available, status: 'idle', progress: null })
        await refreshLanguages()
      } catch (error) {
        if (error instanceof AbortedError) emit({ status: 'idle', progress: null })
        else if (error instanceof OfflineError) emit({ status: isOnline() ? 'error' : 'offline', error: error.message, progress: null })
        else emit({ status: 'error', error: error?.message || 'error', progress: null })
        await refreshLanguages().catch(() => {})
      } finally {
        running = null
        syncAbort = null
      }
    })()
    return running
  }

  async function startPictures(lang) {
    if (pictureAborts.has(lang)) return
    const prefs = { ...snapshot.prefs, pictures: { ...snapshot.prefs.pictures, [lang]: true } }
    savePrefs(prefs)
    const cache = await openCache(pictureCacheName(lang))
    if (!cache) {
      setPicture(lang, { status: 'error', error: 'storage' })
      return
    }
    const urls = pictureUrlsFor(await store.getAllSets(lang))
    const controller = new AbortController()
    pictureAborts.set(lang, controller)
    setPicture(lang, { status: 'downloading', done: 0, total: urls.length, error: null })
    try {
      await downloadPictures({
        urls,
        cache,
        fetchImage,
        signal: controller.signal,
        onProgress: ({ done, total }) => setPicture(lang, { status: 'downloading', done, total }),
      })
      setPicture(lang, { status: 'complete', done: urls.length, total: urls.length })
    } catch (error) {
      if (error instanceof AbortedError) setPicture(lang, { status: controller.cancelled ? 'none' : 'paused' })
      else setPicture(lang, { status: 'paused', error: error?.message || 'error' })
    } finally {
      pictureAborts.delete(lang)
    }
  }

  async function removePictures(lang) {
    pictureAborts.get(lang)?.abort()
    await deleteCache(pictureCacheName(lang))
    savePrefs({ ...snapshot.prefs, pictures: { ...snapshot.prefs.pictures, [lang]: false } })
    setPicture(lang, { status: 'none', done: 0, total: 0, error: null })
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    sync,
    cancelSync: () => syncAbort?.abort(),
    refresh: refreshLanguages,
    startPictures,
    resumePictures: startPictures,
    pausePictures: lang => pictureAborts.get(lang)?.abort(),
    cancelPictures: async lang => {
      const controller = pictureAborts.get(lang)
      if (controller) controller.cancelled = true
      await removePictures(lang)
    },
    removePictures,
    /** How many pictures a language needs and how many are cached already (for the idle state). */
    async inspectPictures(lang) {
      const cache = await openCache(pictureCacheName(lang))
      const urls = pictureUrlsFor(await store.getAllSets(lang))
      const done = cache ? await countCachedPictures(urls, cache) : 0
      const status = urls.length > 0 && done === urls.length ? 'complete' : done > 0 ? 'paused' : 'none'
      if (!pictureAborts.has(lang)) setPicture(lang, { status, done, total: urls.length, estimateBytes: estimatePictureBytes(urls.length - done) })
    },
    setEnabled: async value => {
      savePrefs({ ...snapshot.prefs, enabled: value })
      if (value) await sync({ force: true })
      else await removeAll()
    },
    setLanguage: async (lang, value) => {
      savePrefs({ ...snapshot.prefs, languages: { ...snapshot.prefs.languages, [lang]: value } })
      if (value) await sync({ force: true })
      else {
        await store.deleteLanguage(lang)
        await removePictures(lang)
        await refreshLanguages()
      }
    },
    removeAll,
    async hydrate() {
      emit({ languages: snapshot.languages })
      await refreshLanguages().catch(() => {})
    },
  }

  async function removeAll() {
    syncAbort?.abort()
    for (const controller of pictureAborts.values()) controller.abort()
    await store.clearAll()
    for (const name of await listCaches()) {
      if (name.startsWith(PICTURE_CACHE_PREFIX)) await deleteCache(name)
    }
    emit({ languages: {}, progress: null, status: 'idle' })
  }
}
