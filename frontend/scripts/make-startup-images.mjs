// Writes the pure-black iOS launch images (public/startup/) and prints the <link> tags for
// index.html. iOS shows one of these between tapping the Home Screen icon and the first paint;
// black matches the splash's first frame (its ground changes daily, so the image stays plain).
// Run: node scripts/make-startup-images.mjs   (the PNGs are committed; this is for adding sizes)
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

// [CSS width, CSS height, pixel ratio] of current iPhone portrait screens.
export const IPHONES = [
  [440, 956, 3], [402, 874, 3], [420, 912, 3], [430, 932, 3], [393, 852, 3], [428, 926, 3],
  [390, 844, 3], [375, 812, 3], [414, 896, 3], [414, 896, 2], [414, 736, 3], [375, 667, 2], [320, 568, 2],
]

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = buf => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/** A solid black, opaque 8-bit RGB PNG. */
export function blackPng(width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB, no alpha
  const raw = Buffer.alloc((width * 3 + 1) * height) // filter byte 0 + black pixels
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export const startupFile = (w, h) => `pc-startup-${w}x${h}-v1.png`

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'startup')
  fs.mkdirSync(dir, { recursive: true })
  const tags = []
  for (const [cw, ch, ratio] of IPHONES) {
    for (const orientation of ['portrait', 'landscape']) {
      const [pw, ph] = orientation === 'portrait' ? [cw * ratio, ch * ratio] : [ch * ratio, cw * ratio]
      fs.writeFileSync(path.join(dir, startupFile(pw, ph)), blackPng(pw, ph))
      tags.push(
        `    <link rel="apple-touch-startup-image" href="/startup/${startupFile(pw, ph)}" media="(device-width: ${cw}px) and (device-height: ${ch}px) and (-webkit-device-pixel-ratio: ${ratio}) and (orientation: ${orientation})" />`,
      )
    }
  }
  console.log(tags.join('\n'))
}
