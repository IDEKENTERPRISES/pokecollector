// Builds a picture pack the way backend/services/card_picture_packs.py does (tests).
export function buildPack(items, missing = []) {
  const body = []
  let offset = 0
  const index = items.map(item => {
    const entry = { id: item.id, o: offset, l: item.bytes.length, t: item.type || 'image/webp' }
    body.push(item.bytes)
    offset += item.bytes.length
    return entry
  })
  const header = new TextEncoder().encode(JSON.stringify({ v: 1, items: index, missing }))
  const out = new Uint8Array(4 + header.length + offset)
  new DataView(out.buffer).setUint32(0, header.length)
  out.set(header, 4)
  let at = 4 + header.length
  for (const bytes of body) {
    out.set(bytes, at)
    at += bytes.length
  }
  return out.buffer
}

