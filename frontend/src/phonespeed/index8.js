// The phone's int8 picture index (backend/services/card_match/phone.py `pack_index`, magic "PCI8"):
//   "PCI8" | u32 LE header length | JSON header {dim, count, ids} padded with spaces to a 4-byte boundary
//   | count * dim int8 | count float32 LE scales.
// A row's vector is its int8 values times its scale; both the stored rows and the query are unit length,
// so the dot product is the cosine similarity.

export function parseIndex(buffer) {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 8 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'PCI8') {
    throw new Error('Not a phone index file')
  }
  const view = new DataView(buffer)
  const headerLength = view.getUint32(4, true)
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)))
  const { dim, count, ids } = header
  const start = 8 + headerLength
  if (!Array.isArray(ids) || ids.length !== count || bytes.length < start + count * dim + count * 4) {
    throw new Error('The phone index file is cut short')
  }
  const rows = new Int8Array(buffer, start, count * dim)
  const scales = new Float32Array(count)
  for (let i = 0; i < count; i++) scales[i] = view.getFloat32(start + count * dim + i * 4, true)
  return { dim, count, ids, rows, scales }
}

/** Top-k cosine search over several parsed index files (one per set). Returns [{id, score}] best first. */
export function searchTopK(indexes, query, k = 20) {
  const best = [] // sorted descending, at most k long
  let floor = -Infinity
  for (const index of indexes) {
    const { dim, count, rows, scales, ids } = index
    if (query.length !== dim) throw new Error(`The query has ${query.length} numbers, the index ${dim}`)
    for (let i = 0; i < count; i++) {
      const base = i * dim
      let dot = 0
      for (let j = 0; j < dim; j++) dot += rows[base + j] * query[j]
      const score = dot * scales[i]
      if (best.length < k || score > floor) {
        let at = best.length
        while (at > 0 && best[at - 1].score < score) at--
        best.splice(at, 0, { id: ids[i], score })
        if (best.length > k) best.pop()
        floor = best.length === k ? best[k - 1].score : -Infinity
      }
    }
  }
  return best
}

export function l2Normalise(values) {
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i] * values[i]
  const norm = Math.sqrt(sum) || 1
  const out = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) out[i] = values[i] / norm
  return out
}
