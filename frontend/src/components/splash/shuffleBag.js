// The device's shuffle bag: the species the splash has shown, so none repeats until every one
// has appeared. Kept and sent as a bit set in base64url without padding (bit i of byte k is
// species 8k + i + 1), the format backend/services/pokedex_splash.py decodes.

export const MAX_DEX_ID = 1025
const BYTES = Math.ceil(MAX_DEX_ID / 8)
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function encodeSeen(dexIds) {
  const bytes = new Uint8Array(BYTES)
  for (const value of dexIds) {
    const dexId = Number(value)
    if (!Number.isInteger(dexId) || dexId < 1 || dexId > MAX_DEX_ID) continue
    bytes[(dexId - 1) >> 3] |= 1 << ((dexId - 1) & 7)
  }
  let text = ''
  for (let i = 0; i < BYTES; i += 3) {
    const rest = BYTES - i
    const n = (bytes[i] << 16) | ((rest > 1 ? bytes[i + 1] : 0) << 8) | (rest > 2 ? bytes[i + 2] : 0)
    text += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63]
    if (rest > 1) text += ALPHABET[(n >> 6) & 63]
    if (rest > 2) text += ALPHABET[n & 63]
  }
  return text
}

/** The species in an encoded bag. Anything unreadable is an empty bag. */
export function decodeSeen(text) {
  const seen = new Set()
  if (typeof text !== 'string' || !text) return seen
  let buffer = 0
  let bits = 0
  let byteIndex = 0
  for (const char of text) {
    const value = ALPHABET.indexOf(char)
    if (value < 0) return new Set()
    buffer = ((buffer << 6) | value) & 0xfff
    bits += 6
    if (bits < 8) continue
    bits -= 8
    const byte = (buffer >> bits) & 0xff
    for (let bit = 0; bit < 8; bit += 1) {
      const dexId = byteIndex * 8 + bit + 1
      if (byte & (1 << bit) && dexId <= MAX_DEX_ID) seen.add(dexId)
    }
    byteIndex += 1
    if (byteIndex >= BYTES) break
  }
  return seen
}

/** The bag after showing one more species. Once every species has appeared it starts again,
 * holding only the one just shown, so the next pick is never an immediate repeat. */
export function addToBag(text, dexId) {
  const seen = decodeSeen(text)
  seen.add(Number(dexId))
  return encodeSeen(seen.size >= MAX_DEX_ID ? [dexId] : seen)
}
