// Where the card finder spends its time (step 3d). Not a test of behaviour: it is skipped unless PHONE_PROFILE is set, and prints a table.
//
//   PHONE_PROFILE=1 PHONE_PROFILE_PHOTO=frame-1.jpg PHONE_PROFILE_RUNS=5 PHONE_PROFILE_SIDE=2048 npx vitest run src/phonescan/finder/profile.bench.test.js
//
// The default photo is a generated one from the step 1 fixtures (frame-1.jpg, 768x1024), enlarged with the phone's own cubic resizer to the side
// given (default 2048, the size the server stores) so the cost of a full-size photo shows. Times are Node on a desktop CPU: an iPhone is several times
// slower, and the speed-test page measures that for real. No trainer's photo is used.
import { describe, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import jpeg from 'jpeg-js'
import { resizeArea, resizeCubic } from '../../phonespeed/preprocess'
import { augmentedViews, artCrop, DETECT_MAX_SIDE, findCard, findQuad, guideRect, isGuidePicture, rotate180, warpCard, wholeCard } from './finder'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, '..', '..', '..', 'tests', 'fixtures', 'phone-matcher', 'v11', 'finder', 'photos')
const photoArg = process.env.PHONE_PROFILE_PHOTO || 'frame-1.jpg'
const runs = Number(process.env.PHONE_PROFILE_RUNS || 5)
const longSide = Number(process.env.PHONE_PROFILE_SIDE || 2048)

function load(name) {
  const { data, width, height } = jpeg.decode(readFileSync(resolve(fixtures, name)), { useTArray: true, formatAsRGBA: true })
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height }
}

function enlarge(photo, side) {
  const scale = side / Math.max(photo.width, photo.height)
  if (scale === 1) return photo
  const width = Math.round(photo.width * scale)
  const height = Math.round(photo.height * scale)
  const rgb = resizeCubic(photo.data, photo.width, photo.height, width, height, 4)
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) { data[i * 4] = rgb[i * 4]; data[i * 4 + 1] = rgb[i * 4 + 1]; data[i * 4 + 2] = rgb[i * 4 + 2]; data[i * 4 + 3] = 255 }
  return { data, width, height }
}

const now = () => performance.now()
function time(label, fn, table) {
  const samples = []
  let value
  for (let i = 0; i < runs; i++) { const began = now(); value = fn(); samples.push(now() - began) }
  samples.sort((a, b) => a - b)
  table.push({ step: label, 'median ms': Math.round(samples[Math.floor(samples.length / 2)]), 'min ms': Math.round(samples[0]) })
  return value
}

describe.skipIf(!process.env.PHONE_PROFILE)('finder profile', () => {
  it('prints where the time goes', { timeout: 600000 }, () => {
    const photo = enlarge(load(photoArg), longSide)
    console.log(`photo ${photoArg}: ${photo.width}x${photo.height}, ${runs} runs each, detection side ${DETECT_MAX_SIDE}`)
    const table = []
    const scale = Math.min(1, DETECT_MAX_SIDE / Math.max(photo.width, photo.height))
    const sw = Math.round(photo.width * scale)
    const sh = Math.round(photo.height * scale)
    const small = time('1. shrink to the detection copy (area)', () => {
      const rgb = resizeArea(photo.data, photo.width, photo.height, sw, sh, 4)
      const data = new Uint8ClampedArray(sw * sh * 4)
      for (let i = 0; i < sw * sh; i++) { data[i * 4] = rgb[i * 4]; data[i * 4 + 1] = rgb[i * 4 + 1]; data[i * 4 + 2] = rgb[i * 4 + 2]; data[i * 4 + 3] = 255 }
      return { data, width: sw, height: sh }
    }, table)
    const found = time('2. find the quad on the detection copy', () => findQuad(small, guideRect(sw, sh), { check: true, guideInput: isGuidePicture(photo), rejections: [] }), table)
    const quad = found ? found.quad.map(([x, y]) => [x / scale, y / scale]) : [[0, 0], [photo.width, 0], [photo.width, photo.height], [0, photo.height]]
    const card = time('3. warp 630x880 from the full-size photo', () => warpCard(photo, quad), table)
    time('4. whole findCard (hires: false)', () => findCard(photo), table)
    time('5. whole findCard (hires: true, what the matcher uses)', () => findCard(photo, { hires: true }), table)
    time('6. rotate the card 180 degrees', () => rotate180(card), table)
    const views = time('7. tight crop + CLAHE views', () => augmentedViews(card), table)
    time('8. artwork windows of the card and both views', () => [card, ...views].map(view => artCrop(view)), table)
    time('9. whole-picture copy for the second read', () => wholeCard(photo), table)
    console.table(table)
  })

  it('compares smaller detection copies: time, and how far the corners move against the 900 the server uses', { timeout: 600000 }, () => {
    const sides = [900, 720, 640, 480]
    const rows = []
    for (const name of ['frame-1.jpg', 'frame-2.jpg', 'frame-3.jpg', 'guide-tight.jpg', 'guide-loose.jpg', 'large-frame.jpg']) {
      const big = enlarge(load(name), longSide)
      const reference = findCard(big, { detectMaxSide: 900 })
      for (const side of sides) {
        const samples = []
        let got
        for (let i = 0; i < Math.max(1, runs - 2); i++) { const began = now(); got = findCard(big, { detectMaxSide: side }); samples.push(now() - began) }
        samples.sort((a, b) => a - b)
        const shift = reference.quad && got.quad ? Math.max(...got.quad.map(([x, y], n) => Math.hypot(x - reference.quad[n][0], y - reference.quad[n][1]))) : null
        rows.push({ photo: name, side, 'median ms': Math.round(samples[Math.floor(samples.length / 2)]), source: got.source, 'worst corner shift px': shift === null ? '-' : Number(shift.toFixed(1)) })
      }
    }
    console.table(rows)
  })
})
