import { describe, expect, it } from 'vitest'
import { l2Normalise, parseIndex, searchTopK, topkAnswer } from './index8'

/** The bytes backend phone.pack_index writes: "PCI8", u32 header length, padded JSON header, int8 rows, float32 scales. */
function pack(ids, rows, scales) {
  const dim = rows[0].length
  let header = JSON.stringify({ dim, count: ids.length, ids })
  while ((8 + new TextEncoder().encode(header).length) % 4) header += ' '
  const head = new TextEncoder().encode(header)
  const out = new Uint8Array(8 + head.length + ids.length * dim + ids.length * 4)
  out.set([0x50, 0x43, 0x49, 0x38])
  const view = new DataView(out.buffer)
  view.setUint32(4, head.length, true)
  out.set(head, 8)
  let at = 8 + head.length
  for (const row of rows) for (const value of row) view.setInt8(at++, value)
  for (const scale of scales) { view.setFloat32(at, scale, true); at += 4 }
  return out.buffer
}

const quantise = vector => {
  const scale = Math.max(...vector.map(Math.abs)) / 127
  return { row: vector.map(value => Math.round(value / scale)), scale }
}

describe('phone int8 index', () => {
  const vectors = {
    'sv1-1_en': [1, 0, 0, 0],
    'sv1-2_en': [0, 1, 0, 0],
    'sv2-1_en': [0.6, 0.8, 0, 0],
    'sv2-2_en': [0, 0, 1, 0],
    'sv2-3_en': [0, 0, 0, 1],
  }
  const file = ids => {
    const packed = ids.map(id => quantise(vectors[id]))
    return pack(ids, packed.map(item => item.row), packed.map(item => item.scale))
  }

  it('reads the header, the rows and the scales (including a scale block that is not 4-byte aligned)', () => {
    const index = parseIndex(file(['sv1-1_en', 'sv1-2_en', 'sv2-1_en']))
    expect(index).toMatchObject({ dim: 4, count: 3, ids: ['sv1-1_en', 'sv1-2_en', 'sv2-1_en'] })
    expect(index.rows[0]).toBe(127)
    expect(index.rows[4 + 1]).toBe(127)
    expect(index.scales[0]).toBeCloseTo(1 / 127, 7)
    expect(index.scales[2]).toBeCloseTo(0.8 / 127, 7)
  })

  it('rejects other files and cut-short ones', () => {
    expect(() => parseIndex(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer)).toThrow('Not a phone index file')
    expect(() => parseIndex(file(['sv1-1_en', 'sv1-2_en']).slice(0, 60))).toThrow('cut short')
  })

  it('finds the top cards across several set files, best first, with cosine scores', () => {
    const indexes = [parseIndex(file(['sv1-1_en', 'sv1-2_en'])), parseIndex(file(['sv2-1_en', 'sv2-2_en', 'sv2-3_en']))]
    const query = l2Normalise(Float32Array.from([0.5, 1, 0, 0]))
    const top = searchTopK(indexes, query, 3)
    expect(top.map(item => item.id)).toEqual(['sv2-1_en', 'sv1-2_en', 'sv1-1_en'])
    expect(top[0].score).toBeCloseTo((0.5 * 0.6 + 0.8) / Math.hypot(0.5, 1), 2)
    expect(top[1].score).toBeCloseTo(1 / Math.hypot(0.5, 1), 2)
    expect(top[0].score).toBeGreaterThan(top[1].score)
    expect(searchTopK(indexes, query, 20)).toHaveLength(5) // fewer cards than k
  })

  it('builds the art list from the artwork-window embedding, not the whole-card one', () => {
    const whole = [parseIndex(file(['sv1-1_en', 'sv1-2_en']))]
    const art = [parseIndex(file(['sv2-2_en', 'sv2-3_en']))] // an artwork index: its rows are art-window embeddings
    const wholeQuery = Float32Array.from([1, 0, 0, 0]) // the whole card looks like card 1
    const artQuery = Float32Array.from([0, 0, 0, 1]) // its artwork window looks like the art row 'sv2-3'
    const answer = topkAnswer({ embedding: wholeQuery, artEmbedding: artQuery, wholeIndexes: whole, artIndexes: art })
    expect(answer.whole[0][0]).toBe('sv1-1_en')
    expect(answer.art[0][0]).toBe('sv2-3_en')
    expect(answer.art[0][1]).toBeCloseTo(1, 2)
    expect(topkAnswer({ embedding: wholeQuery, wholeIndexes: whole, artIndexes: art }).art).toBeUndefined() // no art embedding, no art list
  })

  it('refuses a query of the wrong size', () => {
    expect(() => searchTopK([parseIndex(file(['sv1-1_en']))], new Float32Array(3), 5)).toThrow('3 numbers')
  })
})
