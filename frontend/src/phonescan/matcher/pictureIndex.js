// The picture side of the matcher: the phone's int8 indexes (one file per set and kind, see phonespeed/index8.js) held as
// they were read, and the cosine search over ALL of their rows, which is what `decideCard` needs (full score vectors:
// a text candidate outside the picture's top 20 still needs its picture similarity and rank).
//
// pipeline._main_scores / _picture_scores, in JavaScript:
//   best  = per card, the best over the views the whole-card index is asked (card, card turned, then the two augmented views)
//   own   = per card, the best over the artwork views of the artwork index (0 views of a card the art index lacks use `best`)
//   score = (best + own) / 2          art = own
import { parseIndex } from '../../phonespeed/index8'

/** Builds the search structure from parsed index files ({dim, count, ids, rows, scales}). Row order is file order. */
export function buildPictureIndex(wholeFiles, artFiles) {
  const dim = wholeFiles[0]?.dim ?? artFiles[0]?.dim ?? 0
  const layout = files => {
    let total = 0
    const parts = files.map(file => {
      if (file.dim !== dim) throw new Error('The index files do not share one vector size')
      const part = { rows: file.rows, scales: file.scales, count: file.count, offset: total }
      total += file.count
      return part
    })
    return { parts, total }
  }
  const whole = layout(wholeFiles)
  const art = layout(artFiles)
  const ids = new Array(whole.total)
  wholeFiles.forEach((file, n) => { for (let i = 0; i < file.count; i++) ids[whole.parts[n].offset + i] = file.ids[i] })
  const artRowOf = new Map()
  artFiles.forEach((file, n) => { for (let i = 0; i < file.count; i++) if (!artRowOf.has(file.ids[i])) artRowOf.set(file.ids[i], art.parts[n].offset + i) })
  const artRowFor = new Int32Array(ids.length)
  for (let row = 0; row < ids.length; row++) artRowFor[row] = artRowOf.has(ids[row]) ? artRowOf.get(ids[row]) : -1
  const rowOf = new Map(ids.map((id, row) => [id, row])) // made once: the decision looks cards up by id on every photo
  return { dim, ids, whole, art, artRowFor, rowOf, count: ids.length, artCount: art.total }
}

/** Parses the index files ({path -> ArrayBuffer}) into a picture index. Paths are `index/whole/<set>.bin` and `index/art/<set>.bin`. */
export function pictureIndexFromBuffers(buffers) {
  const paths = Object.keys(buffers).sort()
  const pick = prefix => paths.filter(path => path.startsWith(prefix)).map(path => parseIndex(buffers[path]))
  return buildPictureIndex(pick('index/whole/'), pick('index/art/'))
}

/**
 * Cosine search of `queries` (unit Float32Arrays) over a layout's rows. Returns {best: Float32Array(total) (per row, the best over
 * the queries), viewMax: number[] (per query, the best score over all rows)}.
 */
export function searchLayout(layout, dim, queries) {
  const best = new Float32Array(layout.total).fill(-Infinity)
  const viewMax = queries.map(() => -Infinity)
  for (const query of queries) if (query.length !== dim) throw new Error(`The query has ${query.length} numbers, the index ${dim}`)
  for (const part of layout.parts) {
    const { rows, scales, count, offset } = part
    for (let i = 0; i < count; i++) {
      const base = i * dim
      const scale = scales[i]
      let top = -Infinity
      for (let q = 0; q < queries.length; q++) {
        const query = queries[q]
        let dot = 0
        for (let j = 0; j < dim; j++) dot += rows[base + j] * query[j]
        const score = Math.fround(dot * scale)
        if (score > top) top = score
        if (score > viewMax[q]) viewMax[q] = score
      }
      best[offset + i] = top
    }
  }
  return { best, viewMax }
}

/** The whole-card search over the first views (orientation): per-card best and each view's best score. */
export const searchWhole = (index, queries) => searchLayout(index.whole, index.dim, queries)

/** The artwork search: per art row, the best over the queries. */
export const searchArt = (index, queries) => searchLayout(index.art, index.dim, queries).best

/** Elementwise maximum into `into` (the server's `np.maximum(best, extra)`). */
export function maxInto(into, other) {
  for (let i = 0; i < into.length; i++) if (other[i] > into[i]) into[i] = other[i]
  return into
}

/**
 * pipeline._picture_scores: `best` (whole-card best over every view so far), `artBest` (per art row; null without art) ->
 * {ids, scores, art}. A card the art index lacks scores `best` for its art part (`own`), as the server does.
 */
export function combineScores(index, best, artBest) {
  if (!artBest) return { ids: index.ids, scores: best, art: null, rowOf: index.rowOf }
  const scores = new Float32Array(best.length)
  const art = new Float32Array(best.length)
  for (let row = 0; row < best.length; row++) {
    const at = index.artRowFor[row]
    const own = at >= 0 ? artBest[at] : best[row]
    art[row] = own
    scores[row] = (best[row] + own) / 2
  }
  return { ids: index.ids, scores, art, rowOf: index.rowOf }
}
