// The phone matcher's module Web Worker: `new Worker(new URL('./worker.js', import.meta.url), {type: 'module'})`.
// All it does is wire `host.js` to this scope: the downloaded bundle files from Cache Storage, onnxruntime-web, and the offline
// card database (IndexedDB). See docs/phone-scanner/integration.md for the protocol.
import { createCardDbStore } from '../../offline/carddb/store'
import { CACHE_NAME, entryOf, readCached } from '../../phonespeed/bundleCache'
import { createMatcherHost } from './host'
import { loadGpuRuntime, loadWasmRuntime, probeWebGpu } from './ort'

let manifest = null
let cardDb = null
try { cardDb = createCardDbStore() } catch { cardDb = null } // no IndexedDB: the matcher runs picture only

const host = createMatcherHost({
  post: (message, transfer) => self.postMessage(message, transfer || []),
  files: {
    async read(path) {
      const entry = entryOf(manifest, path)
      return entry ? readCached(await caches.open(CACHE_NAME), entry) : null
    },
  },
  loadWasm: loadWasmRuntime,
  loadGpu: loadGpuRuntime,
  probeGpu: () => probeWebGpu(self.navigator),
  cardDb,
})

self.onmessage = event => {
  if (event.data?.type === 'init') manifest = event.data.manifest
  host.handle(event.data)
}
