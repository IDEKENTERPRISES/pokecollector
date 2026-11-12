import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ART_BOX, cardViews, cropRgba, guideCardBox } from './views'

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'phone-matcher', 'v11')

describe('the phone card crop', () => {
  it('computes the guide box exactly as the server does for its "phone way" check (shared reference file)', () => {
    const reference = JSON.parse(readFileSync(resolve(fixtures, 'guide-box-reference.json'), 'utf-8'))
    expect(reference.cases.length).toBeGreaterThan(5)
    for (const { width, height, box } of reference.cases) {
      guideCardBox(width, height).forEach((value, i) => expect(value, `${width}x${height} [${i}]`).toBeCloseTo(box[i], 9))
    }
  })

  it('builds the artwork view from the artwork window of the card, and the seven views the kept set embeds', () => {
    const width = 63
    const height = 88
    const rgba = new Uint8ClampedArray(width * height * 4).fill(255)
    const views = cardViews({ data: rgba, width, height })
    expect(views.map(view => view.name)).toEqual(['upright', 'turned', 'tight', 'contrast', 'art', 'art-tight', 'art-contrast'])
    const art = views.find(view => view.name === 'art')
    const expected = cropRgba(rgba, width, height, ART_BOX)
    expect([art.width, art.height]).toEqual([expected.width, expected.height])
    expect(art.height).toBeLessThan(height / 2)
  })
})
