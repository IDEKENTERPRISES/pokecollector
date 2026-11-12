// The picture search over all rows (step 3d): the int8 dot product, the best over several views, the artwork alignment and the score
// the server computes in pipeline._picture_scores, against a plain floating-point reference on random data.
import { describe, expect, it } from 'vitest'
import { pack } from './testIndex'
import { buildPictureIndex, combineScores, maxInto, pictureIndexFromBuffers, searchArt, searchWhole } from './pictureIndex'

function random(seed) {
  let state = seed
  return () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296 }
}
const DIM = 24

function makeFile(ids, rand) {
  const vectors = ids.map(() => Array.from({ length: DIM }, () => rand() * 2 - 1))
  return { file: pack(ids, vectors), vectors }
}
const unit = (rand) => { const v = Float32Array.from({ length: DIM }, () => rand() * 2 - 1); const n = Math.hypot(...v); return v.map(x => x / n) }

describe('searching all rows', () => {
  const rand = random(7)
  const wholeA = makeFile(['a1_en', 'a2_en', 'a3_en'], rand)
  const wholeB = makeFile(['b1_en', 'b2_en'], rand)
  const artA = makeFile(['a1_en', 'a3_en'], rand) // a2 has no artwork row
  const artB = makeFile(['b1_en', 'b2_en'], rand)
  const index = buildPictureIndex([wholeA.file, wholeB.file], [artA.file, artB.file])
  const dequantised = file => file.vectors.map((vector, i) => Array.from(vector).map((_, j) => file.file.rows[i * DIM + j] * file.file.scales[i]))

  it('lists every card of every set file in file order and counts them', () => {
    expect(index.ids).toEqual(['a1_en', 'a2_en', 'a3_en', 'b1_en', 'b2_en'])
    expect([index.count, index.artCount, index.dim]).toEqual([5, 4, DIM])
    expect(Array.from(index.artRowFor)).toEqual([0, -1, 1, 2, 3])
  })

  it('scores every row with the 8-bit dot product (row values times the row scale) and keeps the best over the views', () => {
    const queries = [unit(rand), unit(rand), unit(rand)]
    const found = searchWhole(index, queries)
    const rows = [...dequantised(wholeA), ...dequantised(wholeB)]
    const expected = rows.map(row => Math.max(...queries.map(query => row.reduce((sum, value, j) => sum + value * query[j], 0))))
    expect(found.best).toHaveLength(5)
    found.best.forEach((score, row) => expect(score).toBeCloseTo(expected[row], 5))
    queries.forEach((query, q) => expect(found.viewMax[q]).toBeCloseTo(Math.max(...rows.map(row => row.reduce((sum, value, j) => sum + value * query[j], 0))), 5))
  })

  it('searches the artwork index on its own rows', () => {
    const query = unit(rand)
    const art = searchArt(index, [query])
    const rows = [...dequantised(artA), ...dequantised(artB)]
    expect(art).toHaveLength(4)
    art.forEach((score, row) => expect(score).toBeCloseTo(rows[row].reduce((sum, value, j) => sum + value * query[j], 0), 5))
  })

  it('rejects a query of the wrong size', () => {
    expect(() => searchWhole(index, [new Float32Array(3)])).toThrow(/3 numbers/)
  })

  it('combines whole and artwork the way the server does: (best + own) / 2, with the whole score standing in for a card without artwork', () => {
    const best = Float32Array.from([0.9, 0.8, 0.7, 0.6, 0.5])
    const artBest = Float32Array.from([0.1, 0.3, 0.5, 0.7])
    const combined = combineScores(index, best, artBest)
    expect(Array.from(combined.art)).toEqual([0.1, 0.8, 0.3, 0.5, 0.7].map(Math.fround))
    expect(combined.scores[0]).toBeCloseTo(0.5, 6)
    expect(combined.scores[1]).toBeCloseTo(0.8, 6) // a2: (0.8 + 0.8) / 2
    expect(combined.scores[4]).toBeCloseTo(0.6, 6)
    expect(combined.ids).toBe(index.ids)
  })

  it('without an artwork index the score is the whole-card score and there is no artwork vector', () => {
    const only = buildPictureIndex([wholeA.file], [])
    const best = Float32Array.from([0.9, 0.8, 0.7])
    expect(combineScores(only, best, null)).toEqual({ ids: only.ids, scores: best, art: null, rowOf: only.rowOf })
  })

  it('takes the elementwise maximum like np.maximum', () => {
    const a = Float32Array.from([1, 5, 3])
    expect(Array.from(maxInto(a, Float32Array.from([2, 4, 3])))).toEqual([2, 5, 3])
  })

  it('reads index files from their buffers by path, in path order', () => {
    const index2 = pictureIndexFromBuffers({
      'index/whole/b.bin': wholeB.file.buffer, 'index/whole/a.bin': wholeA.file.buffer, 'index/art/a.bin': artA.file.buffer,
    })
    expect(index2.ids).toEqual(['a1_en', 'a2_en', 'a3_en', 'b1_en', 'b2_en'])
    expect(index2.artCount).toBe(2)
  })

  it('refuses files that do not share one vector size', () => {
    const odd = pack(['z_en'], [[1, 0, 0]])
    expect(() => buildPictureIndex([wholeA.file, odd], [])).toThrow(/vector size/)
  })
})
