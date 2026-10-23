// The offline card database's state machine (F13): per-device preferences, the sync run, the
// optional pictures download, and a snapshot for the UI. Browser pieces (IndexedDB store, fetch,
// Cache Storage, localStorage) are injected so it can be tested without a browser.

import { PictureError, statusError, timed } from './net.js'
import {
  PICTURE_CACHE_PREFIX,
  STALL_MS,
  createPictureRecord,
  downloadPictures,
  estimatePictureBytes,
  inspectPictureSets,
} from './pictures.js'
import { createPictureStore } from './pictureStore.js'
import { dismissPictureMigrationNotice, migrateLegacyPictureCaches, readPictureMigrationNotice } from './pictureMigration.js'
import { AbortedError, OfflineError, runCardDbSync } from './sync.js'

export const PREFS_KEY = 'pc-carddb-prefs'
export const SYNC_THROTTLE_MS = 60 * 1000
// The service worker's cache of pictures seen while browsing; "remove everything" clears it too.
export const VIEWED_IMAGES_CACHE = 'pc-images-v1'
export const JSON_TIMEOUT_MS = 45 * 1000
const RETRY_STATUSES = new Set([429, 502, 503, 504])
const SPEED_WINDOW_MS = 15 * 1000
const WATCHDOG_TICK_MS = 5 * 1000
// A download that paused because of the connection tries again by itself, later each time.
const AUTO_RESUME_BASE_MS = 20 * 1000
const AUTO_RESUME_MAX_MS = 2 * 60 * 1000
const CONNECTION_REASONS = ['offline', 'network', 'timeout', 'server']
/** How long "Up to date" stays visible after a check that found nothing new. */
export const UP_TO_DATE_SHOWN_MS = 4 * 1000

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
      let data
      try {
        const token = getToken()
        // The deadline covers the body too: a stalled connection must not hang a sync for good.
        ;({ response, data } = await timed(async inner => {
          const reply = await fetchImpl(path, {
            signal: inner,
            cache: 'no-cache',
            headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          })
          return { response: reply, data: reply.ok && reply.status !== 304 ? await reply.json() : undefined }
        }, JSON_TIMEOUT_MS, signal))
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
      return { status: response.status, data, etag }
    }
  }
}

/** A picture pack fetch (the body is read here, so the caller's deadline covers it). Rejects with a
 *  statusError for 5xx, 429 and 401; 404 and 403 resolve as `{ status }` (packs are off or unknown). */
export function createFetchPack({ fetchImpl = globalThis.fetch?.bind(globalThis), getToken = () => globalThis.localStorage?.getItem('token') } = {}) {
  return async function fetchPack(path, signal, onChunk) {
    const token = getToken()
    const response = await fetchImpl(path, {
      signal,
      cache: 'no-store',
      headers: { Accept: 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    })
    if (response.status === 404 || response.status === 403) return { status: response.status }
    if (!response.ok) throw statusError(response.status)
    return { status: 200, buffer: await readBody(response, onChunk) }
  }
}

/** The body as one buffer, read chunk by chunk so every chunk counts as a sign of life (a stalled
 *  stream stops reporting and the download's watchdog pauses it). */
async function readBody(response, onChunk) {
  const reader = response.body?.getReader?.()
  if (!reader) return response.arrayBuffer()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
    onChunk?.()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged.buffer
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
  picturesMigrated: [], // languages whose old pictures were removed (F16a): Settings says to download again
})

export function createCardDbController({
  store,
  fetchJson,
  fetchImage = (url, signal) => globalThis.fetch(url, { signal }),
  fetchPack = createFetchPack(),
  sleep = undefined,
  pictureStore = createPictureStore(),
  deleteCache = name => globalThis.caches?.delete(name),
  listCaches = () => globalThis.caches?.keys() ?? Promise.resolve([]),
  storage = globalThis.localStorage,
  isOnline = () => globalThis.navigator?.onLine !== false,
  requestPersist = () => globalThis.navigator?.storage?.persist?.(),
  now = Date.now,
  stallMs = STALL_MS,
  autoResumeBaseMs = AUTO_RESUME_BASE_MS,
} = {}) {
  let snapshot = { ...initialSnapshot(), prefs: readPrefs(storage), picturesMigrated: readPictureMigrationNotice(storage) }
  const listeners = new Set()
  let running = null
  let lastRunAt = 0
  let persistAsked = false
  let syncAbort = null
  const pictureAborts = new Map()
  const pictureRuns = new Map()
  const resumeTimers = new Map()
  const resumeAttempts = new Map()

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
      emit({ status: 'checking', error: null, progress: null, upToDateAt: null })
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
        const changed = result.languages.some(item => !item.upToDate)
        emit({
          serverEnabled: true, available: result.available, status: 'idle', progress: null,
          checkedAt: now(), upToDateAt: changed ? null : now(),
        })
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

  const pictureRecord = lang => createPictureRecord(storage, lang)

  /** Speed (bytes/s over the last seconds), and the time left from the average size of the sets done so far. */
  function pictureStats({ samples, startBytes, remainingEstimate }, { doneSets, totalSets, bytes }) {
    const t = now()
    samples.push({ t, bytes })
    while (samples.length > 2 && t - samples[0].t > SPEED_WINDOW_MS) samples.shift()
    const first = samples[0]
    const span = (t - first.t) / 1000
    const speed = span >= 1 && bytes > first.bytes ? (bytes - first.bytes) / span : null
    const done = startBytes + bytes
    const perSet = doneSets > 0 && done > 0 ? done / doneSets : remainingEstimate / Math.max(1, totalSets - doneSets)
    const remainingBytes = perSet * (totalSets - doneSets)
    return {
      bytes: done,
      speed,
      etaSeconds: speed ? Math.round(remainingBytes / speed) : null,
    }
  }

  const clearResume = lang => {
    globalThis.clearTimeout(resumeTimers.get(lang))
    resumeTimers.delete(lang)
  }

  /** Tries a connection-paused download again after a while (later each time), if it is still paused. */
  function scheduleResume(lang) {
    clearResume(lang)
    const attempt = resumeAttempts.get(lang) ?? 0
    resumeAttempts.set(lang, attempt + 1)
    resumeTimers.set(lang, globalThis.setTimeout(() => {
      resumeTimers.delete(lang)
      const { status, reason } = snapshot.languages[lang]?.pictures ?? {}
      if (snapshot.prefs.pictures[lang] && status === 'paused' && CONNECTION_REASONS.includes(reason) && isOnline()) startPictures(lang)
      else if (snapshot.prefs.pictures[lang] && status === 'paused' && CONNECTION_REASONS.includes(reason)) scheduleResume(lang)
    }, Math.min(autoResumeBaseMs * 2 ** attempt, AUTO_RESUME_MAX_MS)))
  }

  async function runPictures(lang) {
    const controller = new AbortController()
    pictureAborts.set(lang, controller)
    clearResume(lang)
    // Watchdog: no sign of life for `stallMs` (hanging requests, a body that stops mid-way) pauses the
    // download, whatever the retries underneath are still doing. navigator.onLine is not trusted here.
    let lastActivity = now()
    let stalled = false
    const touch = () => {
      lastActivity = now()
      resumeAttempts.delete(lang)
    }
    const watchdog = globalThis.setInterval(() => {
      if (now() - lastActivity >= stallMs) {
        stalled = true
        controller.abort()
      }
    }, Math.min(WATCHDOG_TICK_MS, Math.max(50, stallMs / 4)))
    try {
      savePrefs({ ...snapshot.prefs, pictures: { ...snapshot.prefs.pictures, [lang]: true } })
      const sets = await store.getAllSets(lang)
      const record = pictureRecord(lang)
      const startBytes = record.bytes()
      const samples = [{ t: now(), bytes: 0 }]
      const context = { record, samples, startBytes, remainingEstimate: estimatePictureBytes(sets.length * 80) }
      setPicture(lang, {
        status: 'downloading', reason: null, error: null, doneSets: record.doneCount(), totalSets: sets.length,
        bytes: startBytes, speed: null, etaSeconds: null,
      })
      try {
        await downloadPictures({
          lang,
          sets,
          store: pictureStore,
          fetchPack,
          fetchImage,
          record,
          signal: controller.signal,
          sleep,
          onActivity: touch,
          onProgress: progress => setPicture(lang, {
            status: 'downloading', doneSets: progress.doneSets, totalSets: progress.totalSets, ...pictureStats(context, progress),
          }),
        })
        setPicture(lang, { status: 'complete', reason: null, doneSets: sets.length, totalSets: sets.length, speed: null, etaSeconds: null, skipped: record.skipped() })
      } catch (error) {
        if (controller.removed) return
        const stopped = { speed: null, etaSeconds: null, bytes: record.bytes(), doneSets: record.doneCount() }
        if (error instanceof AbortedError && !stalled) setPicture(lang, { status: 'paused', reason: 'user', ...stopped })
        else {
          // A request that hangs while the phone is offline times out; say "offline" then, not "stalled".
          const reason = !isOnline() ? 'offline' : stalled ? 'timeout' : error instanceof PictureError ? error.reason : 'error'
          setPicture(lang, { status: 'paused', reason, error: error?.message || 'error', ...stopped })
          if (CONNECTION_REASONS.includes(reason)) scheduleResume(lang)
        }
      }
    } finally {
      globalThis.clearInterval(watchdog)
      pictureAborts.delete(lang)
    }
  }

  /** Starts or resumes a language's pictures: finished sets are skipped. One run per language at a time. */
  function startPictures(lang) {
    if (pictureRuns.has(lang)) return pictureRuns.get(lang)
    const run = runPictures(lang).finally(() => pictureRuns.delete(lang))
    pictureRuns.set(lang, run)
    return run
  }

  async function stopPictures(lang, { removed = false } = {}) {
    clearResume(lang)
    const controller = pictureAborts.get(lang)
    if (controller) {
      controller.removed = removed
      controller.abort()
    }
    await pictureRuns.get(lang)?.catch(() => {})
  }

  async function removePictures(lang) {
    await stopPictures(lang, { removed: true })
    await pictureStore.deleteLanguage(lang).catch(() => {})
    pictureRecord(lang).clear()
    savePrefs({ ...snapshot.prefs, pictures: { ...snapshot.prefs.pictures, [lang]: false } })
    setPicture(lang, { status: 'none', reason: null, doneSets: 0, totalSets: 0, bytes: 0, speed: null, etaSeconds: null, error: null })
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
    cancelPictures: removePictures,
    removePictures,
    /** Resumes the downloads that stopped because the connection was lost or stalled (on "online"). */
    resumeStalledPictures() {
      for (const [lang, info] of Object.entries(snapshot.languages)) {
        const { status, reason } = info?.pictures ?? {}
        if (snapshot.prefs.pictures[lang] && status === 'paused' && ['offline', 'network', 'timeout', 'server'].includes(reason)) startPictures(lang)
      }
    },
    /** What a language's pictures look like now: sets done of total, from the saved progress (idle state). */
    async inspectPictures(lang) {
      if (pictureRuns.has(lang)) return
      const sets = await store.getAllSets(lang)
      const record = pictureRecord(lang)
      const { doneSets, totalSets, remainingUrls } = await inspectPictureSets({ sets, store: pictureStore, record })
      const status = totalSets > 0 && doneSets === totalSets ? 'complete' : doneSets > 0 ? 'paused' : 'none'
      if (!pictureRuns.has(lang)) {
        setPicture(lang, {
          status, reason: null, doneSets, totalSets, bytes: record.bytes(), skipped: record.skipped(),
          estimateBytes: estimatePictureBytes(remainingUrls),
        })
      }
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
    /**
     * Deletes the pre-F16a picture caches (call it after start-up, never on the launch path). Their
     * languages go back to "not downloaded"; `picturesMigrated` then lists them for a Settings notice.
     */
    async migrateLegacyPictures() {
      const langs = await migrateLegacyPictureCaches({ listCaches, deleteCache, storage })
      if (!langs.length) return
      const pictures = { ...snapshot.prefs.pictures }
      for (const lang of langs) {
        await stopPictures(lang, { removed: true })
        pictures[lang] = false
        setPicture(lang, { status: 'none', reason: null, doneSets: 0, totalSets: 0, bytes: 0, speed: null, etaSeconds: null, error: null })
      }
      savePrefs({ ...snapshot.prefs, pictures })
      emit({ picturesMigrated: readPictureMigrationNotice(storage) })
    },
    dismissPicturesMigrationNotice() {
      dismissPictureMigrationNotice(storage)
      emit({ picturesMigrated: [] })
    },
    async hydrate() {
      emit({ languages: snapshot.languages })
      await refreshLanguages().catch(() => {})
    },
  }

  async function removeAll() {
    syncAbort?.abort()
    const langs = new Set([...snapshot.available, ...Object.keys(snapshot.languages), ...Object.keys(snapshot.prefs.pictures)])
    await Promise.all([...pictureRuns.keys()].map(lang => stopPictures(lang, { removed: true })))
    await store.clearAll()
    await pictureStore.clearAll().catch(() => {})
    for (const name of await listCaches()) {
      if (name.startsWith(PICTURE_CACHE_PREFIX) || name === VIEWED_IMAGES_CACHE) await deleteCache(name)
    }
    for (const lang of langs) {
      pictureRecord(lang).clear()
      clearResume(lang)
    }
    // Off, so nothing downloads again behind the person's back; the Settings section stays with
    // a Download button. The server's answer is kept: the section must not depend on local data.
    savePrefs({ ...snapshot.prefs, enabled: false, pictures: {} })
    emit({ languages: {}, progress: null, status: 'idle', serverEnabled: snapshot.serverEnabled ?? true, upToDateAt: null })
  }
}
