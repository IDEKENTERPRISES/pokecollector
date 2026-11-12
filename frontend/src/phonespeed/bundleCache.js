// The phone bundle's manifest, downloads and Cache Storage copy for the speed test.
// Everything that touches the network or storage is passed in (getJson, getBytes, cache, subtle), so the unit tests
// run it with fakes. The files live in their own cache; the service worker never touches it (it only deletes its
// own `pc-precache-*` and `pc-shell-*` caches).

export const CACHE_NAME = 'pc-phone-speed-v1'
export const MANIFEST_PATH = '/card-match/phone-bundle/manifest'
export const FILE_PATH = '/card-match/phone-bundle/files/'
const KEY_PREFIX = '/__phone-speed/'

/** A manifest file entry by exact path. */
export const entryOf = (manifest, path) => (manifest?.files || []).find(item => item.path === path) || null

/** The entries the speed test needs. `webgpu` adds the optional fp16 model when the bundle holds it. */
export function testFiles(manifest, { webgpu = true } = {}) {
  const files = manifest?.files || []
  const wanted = files.filter(item => item.path === manifest?.model?.file
    || item.path.startsWith('index/')
    || item.path.startsWith('ocr/'))
  if (webgpu) {
    const fp16 = entryOf(manifest, manifest?.model?.webgpu_candidate?.file)
    if (fp16) wanted.push(fp16)
  }
  return wanted
}

export const totalBytes = entries => entries.reduce((sum, item) => sum + item.size, 0)

export const megabytes = bytes => `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`

export async function sha256Hex(buffer, subtle = globalThis.crypto?.subtle) {
  const digest = await subtle.digest('SHA-256', buffer)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Cache key: the content hash is in it, so a rebuilt bundle never answers with an old file. */
export const cacheKey = entry => `${KEY_PREFIX}${entry.sha256}/${entry.path}`

/** Which of the entries are already in the cache (right size), and how many bytes are still to download. */
export async function cacheState(cache, entries) {
  const cached = []
  const missing = []
  for (const entry of entries) {
    const hit = await cache.match(cacheKey(entry))
    if (hit && Number(hit.headers.get('content-length')) === entry.size) cached.push(entry)
    else missing.push(entry)
  }
  return { cached, missing, missingBytes: totalBytes(missing) }
}

/**
 * Download what is missing, check each file's sha256 against the manifest, store it in the cache.
 * `getBytes(path, onChunk)` returns an ArrayBuffer and calls onChunk(bytesSoFar) as data arrives.
 * `onProgress({done, total, file})` counts bytes over everything that has to be downloaded.
 * A file whose hash does not match is not stored and throws.
 */
export async function downloadMissing({ cache, entries, getBytes, onProgress = () => {}, subtle }) {
  const { missing, missingBytes } = await cacheState(cache, entries)
  let finished = 0
  for (const entry of missing) {
    onProgress({ done: finished, total: missingBytes, file: entry.path })
    const buffer = await getBytes(entry.path, so_far => onProgress({ done: finished + Math.min(so_far, entry.size), total: missingBytes, file: entry.path }))
    if (buffer.byteLength !== entry.size) throw new Error(`${entry.path}: ${buffer.byteLength} bytes arrived, the manifest says ${entry.size}`)
    const hash = await sha256Hex(buffer, subtle)
    if (hash !== entry.sha256) throw new Error(`${entry.path}: the checksum does not match the manifest`)
    await cache.put(cacheKey(entry), new Response(buffer, { headers: { 'content-length': String(entry.size), 'content-type': 'application/octet-stream' } }))
    finished += entry.size
  }
  onProgress({ done: missingBytes, total: missingBytes, file: null })
  return { downloaded: missing.length, bytes: missingBytes }
}

/** One cached file as an ArrayBuffer (null when it is not cached). */
export async function readCached(cache, entry) {
  const hit = await cache.match(cacheKey(entry))
  return hit ? hit.arrayBuffer() : null
}

/** "Remove test files": the whole cache goes. */
export async function removeTestFiles(cacheStorage) {
  return cacheStorage.delete(CACHE_NAME)
}

/** Real network helpers for the page (the app's axios client carries the sign-in token). */
export function networkHelpers(api) {
  return {
    getJson: path => api.get(path).then(response => response.data),
    getBytes: (path, onChunk) => api.get(FILE_PATH + path, {
      responseType: 'arraybuffer', timeout: 0,
      onDownloadProgress: event => onChunk?.(event.loaded || 0),
    }).then(response => response.data),
  }
}
