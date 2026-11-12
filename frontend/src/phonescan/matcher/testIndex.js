// Test helper: builds an index file ({dim, count, ids, rows, scales, buffer}) from float vectors in the phone's PCI8 format
// (backend/services/card_match/phone.py pack_index): int8 rows and one scale per row, max|row| / 127, then parsed with the real reader.
import { parseIndex } from '../../phonespeed/index8'

export function pack(ids, vectors) {
  const dim = vectors[0].length
  const count = ids.length
  const header = new TextEncoder().encode(JSON.stringify({ dim, count, ids }))
  const padded = header.length + ((4 - ((8 + header.length) % 4)) % 4)
  const total = 8 + padded + count * dim + count * 4
  const buffer = new ArrayBuffer(total)
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  bytes.set([0x50, 0x43, 0x49, 0x38])
  view.setUint32(4, padded, true)
  bytes.fill(0x20, 8, 8 + padded)
  bytes.set(header, 8)
  const start = 8 + padded
  vectors.forEach((vector, i) => {
    const scale = Math.max(...vector.map(Math.abs)) / 127
    for (let j = 0; j < dim; j++) view.setInt8(start + i * dim + j, Math.max(-127, Math.min(127, Math.round(vector[j] / (scale || 1)))))
    view.setFloat32(start + count * dim + i * 4, scale, true)
  })
  return Object.assign(parseIndex(buffer), { buffer })
}
