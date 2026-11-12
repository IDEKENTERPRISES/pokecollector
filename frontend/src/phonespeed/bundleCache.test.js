import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CACHE_NAME, cacheKey, cacheState, downloadMissing, readCached, removeTestFiles, sha256Hex, testFiles, totalBytes } from './bundleCache'

const subtle = webcrypto.subtle

class FakeCache {
  constructor() { this.map = new Map() }
  async match(key) { const hit = this.map.get(key); return hit ? hit.clone() : undefined }
  async put(key, response) { this.map.set(key, response) }
}

const bytes = text => new TextEncoder().encode(text).buffer

async function makeManifest() {
  const content = {
    'model/dinov2-small-int8.onnx': 'int8 model bytes',
    'model/dinov2-small-fp16.onnx': 'fp16 model bytes!!',
    'index/whole/sv1.bin': 'whole sv1',
    'index/art/sv1.bin': 'art sv1',
    'ocr/det.onnx': 'det',
    'ocr/rec.onnx': 'recognition',
    'ocr/characters.txt': 'a\nb\n',
    'other/readme.txt': 'not needed',
  }
  const files = []
  for (const [path, text] of Object.entries(content)) {
    files.push({ path, size: bytes(text).byteLength, sha256: await sha256Hex(bytes(text), subtle), ...(path.includes('fp16') ? { optional: true } : {}) })
  }
  return {
    manifest: { model: { file: 'model/dinov2-small-int8.onnx', webgpu_candidate: { file: 'model/dinov2-small-fp16.onnx', in_bundle: true } }, files },
    content,
  }
}

describe('phone bundle download and cache', () => {
  it('picks the files the test needs, and the fp16 model only for WebGPU', async () => {
    const { manifest } = await makeManifest()
    const paths = testFiles(manifest).map(item => item.path)
    expect(paths).toEqual(['index/whole/sv1.bin', 'index/art/sv1.bin', 'ocr/det.onnx', 'ocr/rec.onnx', 'ocr/characters.txt', 'model/dinov2-small-int8.onnx', 'model/dinov2-small-fp16.onnx'].sort((a, b) => paths.indexOf(a) - paths.indexOf(b)))
    expect(paths).not.toContain('other/readme.txt')
    expect(testFiles(manifest, { webgpu: false }).map(item => item.path)).not.toContain('model/dinov2-small-fp16.onnx')
    expect(testFiles({ ...manifest, model: { ...manifest.model, webgpu_candidate: { file: 'model/none.onnx' } } }).length).toBe(6)
  })

  it('downloads what is missing with progress, checks the sha256 and caches it; a second run downloads nothing', async () => {
    const { manifest, content } = await makeManifest()
    const entries = testFiles(manifest)
    const cache = new FakeCache()
    const asked = []
    const getBytes = async (path, onChunk) => {
      asked.push(path)
      const data = bytes(content[path])
      onChunk(Math.floor(data.byteLength / 2))
      return data
    }
    const progress = []
    const first = await downloadMissing({ cache, entries, getBytes, subtle, onProgress: event => progress.push(event) })
    expect(first).toEqual({ downloaded: entries.length, bytes: totalBytes(entries) })
    expect(asked).toHaveLength(entries.length)
    expect(progress.at(-1)).toEqual({ done: totalBytes(entries), total: totalBytes(entries), file: null })
    expect(progress.every(event => event.done <= event.total)).toBe(true)
    expect(progress.map(event => event.done)).toEqual([...progress.map(event => event.done)].sort((a, b) => a - b))
    const state = await cacheState(cache, entries)
    expect(state.missing).toEqual([])

    const again = await downloadMissing({ cache, entries, getBytes: async () => { throw new Error('must not download') }, subtle })
    expect(again).toEqual({ downloaded: 0, bytes: 0 })
    expect(await readCached(cache, entries[0])).toBeInstanceOf(ArrayBuffer)
  })

  it('refuses a file whose checksum or size is wrong and does not cache it', async () => {
    const { manifest } = await makeManifest()
    const entries = testFiles(manifest, { webgpu: false })
    const cache = new FakeCache()
    await expect(downloadMissing({ cache, entries, subtle, getBytes: async () => bytes('x'.repeat(entries[0].size)) })).rejects.toThrow('checksum')
    await expect(downloadMissing({ cache, entries, subtle, getBytes: async () => bytes('short') })).rejects.toThrow('manifest says')
    expect(cache.map.size).toBe(0)
  })

  it('keys the cache by content hash, so a rebuilt bundle is fetched again', async () => {
    const { manifest } = await makeManifest()
    const entry = manifest.files[0]
    expect(cacheKey(entry)).toContain(entry.sha256)
    const cache = new FakeCache()
    await cache.put(cacheKey(entry), new Response(bytes('x'), { headers: { 'content-length': String(entry.size) } }))
    expect((await cacheState(cache, [{ ...entry, sha256: 'f'.repeat(64) }])).missing).toHaveLength(1)
  })

  it('removes the dedicated cache and nothing else', async () => {
    const deleted = []
    expect(await removeTestFiles({ delete: async name => { deleted.push(name); return true } })).toBe(true)
    expect(deleted).toEqual([CACHE_NAME])
    expect(CACHE_NAME).toBe('pc-phone-speed-v1')
  })
})
