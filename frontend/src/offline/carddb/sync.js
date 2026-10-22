// Keeps the offline card database equal to the server's: compares the manifest's hashes with what
// is stored and fetches only what changed (design: F13). Pure of the browser: the store, the
// network and the abort signal are injected, so it is unit-tested with fakes.

export const MANIFEST_PATH = '/api/offline/carddb/manifest'
export const setPath = (lang, setId) => `/api/offline/carddb/sets/${encodeURIComponent(lang)}/${encodeURIComponent(setId)}`
export const pricesPath = lang => `/api/offline/carddb/prices/${encodeURIComponent(lang)}`

/** What a language needs, from the server's manifest entry and the local state. */
export function planSync(remote, local) {
  const remoteSets = new Map((remote?.sets ?? []).map(entry => [entry.id, entry]))
  const localHashes = local?.setHashes ?? new Map()
  const fetchSets = []
  for (const [id, entry] of remoteSets) {
    if (localHashes.get(id) !== entry.hash) fetchSets.push(entry)
  }
  const removeSets = [...localHashes.keys()].filter(id => !remoteSets.has(id))
  const fetchPrices = Boolean(remote?.prices_hash) && local?.pricesHash !== remote.prices_hash
  return {
    fetchSets,
    removeSets,
    fetchPrices,
    upToDate: fetchSets.length === 0 && removeSets.length === 0 && !fetchPrices,
  }
}

export class OfflineError extends Error {}
export class AbortedError extends Error {}

const isNetworkFailure = error => !error?.status

/** Runs `worker(item)` over `items` with at most `concurrency` in flight; stops at the first failure. */
async function pool(items, concurrency, signal, worker) {
  const queue = items.slice()
  let failure = null
  const lane = async () => {
    while (queue.length && !failure) {
      if (signal?.aborted) throw new AbortedError()
      const item = queue.shift()
      try {
        await worker(item)
      } catch (error) {
        failure = failure || error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane))
  if (failure) throw failure
  if (signal?.aborted) throw new AbortedError()
}

/**
 * Brings one language up to date. `fetchJson(path)` resolves `{ status, data, etag, bytes }` and
 * rejects with an error without `status` when the network failed. Sets are saved one at a time
 * as they arrive, so an interrupted run resumes by diffing again.
 * Returns `{ fetchedSets, removedSets, fetchedPrices }`.
 */
export async function syncLanguage({ lang, remote, store, fetchJson, signal, concurrency = 2, onProgress = () => {} }) {
  const local = {
    setHashes: await store.listSetHashes(lang),
    pricesHash: (await store.getMeta(lang))?.pricesHash ?? null,
  }
  const plan = planSync(remote, local)
  const totalBytes = plan.fetchSets.reduce((sum, entry) => sum + (entry.bytes || 0), 0) + (plan.fetchPrices ? (remote.prices_bytes || 0) : 0)
  const progress = { lang, doneSets: 0, totalSets: plan.fetchSets.length, doneBytes: 0, totalBytes }
  onProgress({ ...progress })

  if (plan.removeSets.length) await store.deleteSets(lang, plan.removeSets)

  try {
    await pool(plan.fetchSets, concurrency, signal, async entry => {
      const response = await fetchJson(setPath(lang, entry.id), signal)
      if (response.status === 404) {
        // Removed on the server since the manifest was read: drop it locally too.
        await store.deleteSets(lang, [entry.id])
      } else {
        const saved = await store.putSet(lang, entry.id, {
          hash: response.etag || entry.hash,
          bytes: response.bytes || entry.bytes,
          payload: response.data,
        })
        if (!saved) throw new OfflineError('storage')
      }
      progress.doneSets += 1
      progress.doneBytes += entry.bytes || 0
      onProgress({ ...progress })
    })

    let pricesHash = local.pricesHash
    if (plan.fetchPrices) {
      const response = await fetchJson(pricesPath(lang), signal)
      const saved = await store.putPrices(lang, {
        hash: response.etag || remote.prices_hash,
        updatedAt: remote.prices_updated_at ?? null,
        fields: response.data.fields,
        rows: response.data.rows,
      })
      if (!saved) throw new OfflineError('storage')
      pricesHash = response.etag || remote.prices_hash
      progress.doneBytes += remote.prices_bytes || 0
      onProgress({ ...progress })
    }

    const stored = await store.listSetHashes(lang)
    await store.setMeta(lang, {
      hash: remote.hash,
      pricesHash,
      pricesUpdatedAt: remote.prices_updated_at ?? null,
      pricesBytes: remote.prices_bytes || 0,
      sets: stored.size,
      cards: remote.card_count ?? 0,
      syncedAt: Date.now(),
    })
  } catch (error) {
    if (error instanceof AbortedError || error instanceof OfflineError) throw error
    if (isNetworkFailure(error)) throw new OfflineError(error?.message || 'network')
    throw error
  }
  return {
    fetchedSets: plan.fetchSets.length,
    removedSets: plan.removeSets.length,
    fetchedPrices: plan.fetchPrices,
  }
}

/**
 * One whole run: read the manifest, then per language either sync it (switched on), remove it
 * (switched off or no longer synced by the server), or skip it (nothing changed).
 * Returns `{ status: 'disabled' | 'done', languages: [...] }`; throws OfflineError when the
 * network is gone and AbortedError when cancelled.
 */
export async function runCardDbSync({ wantedLanguages, store, fetchJson, signal, concurrency = 2, onProgress = () => {} }) {
  let manifest
  try {
    const response = await fetchJson(MANIFEST_PATH, signal)
    if (response.status === 404 || response.status === 403) {
      await store.clearAll()
      return { status: 'disabled', languages: [] }
    }
    manifest = response.data
  } catch (error) {
    if (error instanceof AbortedError) throw error
    if (isNetworkFailure(error)) throw new OfflineError(error?.message || 'network')
    throw error
  }

  const remoteLanguages = manifest?.languages ?? {}
  const summary = []
  for (const lang of await store.listLanguages()) {
    if (!remoteLanguages[lang] || !wantedLanguages.includes(lang)) {
      await store.deleteLanguage(lang)
    }
  }
  for (const lang of wantedLanguages) {
    const remote = remoteLanguages[lang]
    if (!remote) continue
    const meta = await store.getMeta(lang)
    if (meta?.hash === remote.hash && meta?.pricesHash === remote.prices_hash) {
      summary.push({ lang, fetchedSets: 0, removedSets: 0, fetchedPrices: false, upToDate: true })
      continue
    }
    const result = await syncLanguage({ lang, remote, store, fetchJson, signal, concurrency, onProgress })
    summary.push({ lang, ...result, upToDate: false })
  }
  return { status: 'done', languages: summary, available: Object.keys(remoteLanguages), manifest: remoteLanguages }
}
