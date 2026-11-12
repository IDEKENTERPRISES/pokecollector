import { describe, expect, it } from 'vitest'
import { detectBoxes, detectionInput } from './detect'
import { readFixture, unpack } from './testkit'

const reference = readFixture('ocr-post.json')

// Corner positions are compared in pixels of the picture the boxes are drawn in (the maps here are half its size).
const BOX_TOLERANCE = 2
const SCORE_TOLERANCE = 0.02

function mapOf(item) {
  const bytes = unpack(item.map)
  const [height, width] = item.map_dims
  const data = new Float32Array(width * height)
  for (let i = 0; i < data.length; i++) data[i] = Math.fround(bytes[i] / 255)
  return { data, width, height }
}

describe('DB post-processing against RapidOCR', () => {
  it.each(reference.cases.map((item, i) => [`${item.name} @ ${item.box_thresh}`, i]))('%s: same boxes within the tolerance', (_name, i) => {
    const item = reference.cases[i]
    const got = detectBoxes(mapOf(item), item.size[0], item.size[1], { boxThresh: item.box_thresh })
    expect(got.length).toBe(item.boxes.length)
    got.forEach((box, k) => {
      box.points.forEach((point, p) => {
        expect(Math.abs(point[0] - item.boxes[k][p][0]), `box ${k} corner ${p} x`).toBeLessThanOrEqual(BOX_TOLERANCE)
        expect(Math.abs(point[1] - item.boxes[k][p][1]), `box ${k} corner ${p} y`).toBeLessThanOrEqual(BOX_TOLERANCE)
      })
    })
    const scores = got.map(box => box.score).sort((a, b) => a - b)
    const expected = item.scores.slice().sort((a, b) => a - b)
    scores.forEach((score, k) => expect(Math.abs(score - expected[k])).toBeLessThan(SCORE_TOLERANCE))
  })

  it('finds nothing in an empty map', () => {
    expect(detectBoxes({ data: new Float32Array(64 * 32), width: 64, height: 32 }, 128, 64)).toEqual([])
  })
})

describe('the detector input', () => {
  const picture = (width, height) => ({ data: new Uint8ClampedArray(width * height * 4).fill(128), width, height })

  it('limits the longest side and rounds both sides to multiples of 32', () => {
    const { tensor, pad } = detectionInput(picture(1000, 300), 480)
    expect(tensor.dims).toEqual([1, 3, 128, 480]) // ratio 0.48: 144 / 32 = 4.5 rounds to the even 4, as Python's round() does
    expect(pad).toBe(0)
  })

  it('pads a very flat strip with black rows first (letterbox), and does not scale below the limit', () => {
    const { tensor, pad, image } = detectionInput(picture(400, 20), 480)
    expect(pad).toBe(40) // new height max(int(400 / 8), 30) * 2 = 100; (100 - 20) / 2
    expect(image.height).toBe(100)
    expect(tensor.dims).toEqual([1, 3, 96, 384]) // 400 / 32 = 12.5 rounds to 12
  })

  it('feeds blue first with the RGB-ordered ImageNet mean, as RapidOCR does with its BGR pictures', () => {
    const img = picture(64, 64)
    for (let i = 0; i < 64 * 64; i++) img.data.set([255, 0, 0, 255], i * 4) // pure red
    const { tensor } = detectionInput(img, 480)
    const plane = 64 * 64
    expect(tensor.data[0]).toBeCloseTo((0 - 0.485) / 0.229, 4) // plane 0 = blue = 0
    expect(tensor.data[2 * plane]).toBeCloseTo((1 - 0.406) / 0.225, 4) // plane 2 = red = 1
  })
})
