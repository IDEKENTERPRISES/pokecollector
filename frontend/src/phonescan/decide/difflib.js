// A faithful port of Python's difflib.SequenceMatcher for the case the matcher uses: no junk function and
// autojunk off (the server always passes `autojunk=False`, so there is no popular-element pruning either).
// The matching blocks (which the card-text lane filters by size) and the ratios must be the same as
// Python's, so the search order and the tie-breaking follow CPython's difflib.py line for line.
//
// Sequences are strings compared by code point, as Python does.

import { chars } from './pyCompat.js'

export class SequenceMatcher {
  constructor(a = '', b = '') {
    this.a = []
    this.b = []
    this.matchingBlocks = null
    this.fullBCount = null
    this.setSeqs(a, b)
  }

  setSeqs(a, b) {
    this.setSeq1(a)
    this.setSeq2(b)
  }

  setSeq1(a) {
    this.a = chars(a)
    this.matchingBlocks = null
  }

  setSeq2(b) {
    this.b = chars(b)
    this.matchingBlocks = null
    this.fullBCount = null
    // b2j: element -> ascending indexes in b
    const b2j = new Map()
    this.b.forEach((element, index) => {
      const list = b2j.get(element)
      if (list) list.push(index)
      else b2j.set(element, [index])
    })
    this.b2j = b2j
  }

  findLongestMatch(alo, ahi, blo, bhi) {
    const { a, b2j } = this
    let besti = alo
    let bestj = blo
    let bestsize = 0
    let j2len = new Map()
    for (let i = alo; i < ahi; i += 1) {
      const newj2len = new Map()
      const indexes = b2j.get(a[i])
      if (indexes) {
        for (const j of indexes) {
          if (j < blo) continue
          if (j >= bhi) break
          const k = (j2len.get(j - 1) ?? 0) + 1
          newj2len.set(j, k)
          if (k > bestsize) {
            besti = i - k + 1
            bestj = j - k + 1
            bestsize = k
          }
        }
      }
      j2len = newj2len
    }
    // No junk and no popular elements: the match cannot be extended any further.
    return { a: besti, b: bestj, size: bestsize }
  }

  getMatchingBlocks() {
    if (this.matchingBlocks) return this.matchingBlocks
    const la = this.a.length
    const lb = this.b.length
    const queue = [[0, la, 0, lb]]
    const blocks = []
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()
      const found = this.findLongestMatch(alo, ahi, blo, bhi)
      const { a: i, b: j, size: k } = found
      if (k) {
        blocks.push([i, j, k])
        if (alo < i && blo < j) queue.push([alo, i, blo, j])
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi])
      }
    }
    blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2])
    let i1 = 0
    let j1 = 0
    let k1 = 0
    const merged = []
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2
      } else {
        if (k1) merged.push({ a: i1, b: j1, size: k1 })
        i1 = i2
        j1 = j2
        k1 = k2
      }
    }
    if (k1) merged.push({ a: i1, b: j1, size: k1 })
    merged.push({ a: la, b: lb, size: 0 })
    this.matchingBlocks = merged
    return merged
  }

  ratio() {
    const matches = this.getMatchingBlocks().reduce((sum, block) => sum + block.size, 0)
    return calculateRatio(matches, this.a.length + this.b.length)
  }

  quickRatio() {
    if (!this.fullBCount) {
      const counts = new Map()
      for (const element of this.b) counts.set(element, (counts.get(element) ?? 0) + 1)
      this.fullBCount = counts
    }
    const available = new Map()
    let matches = 0
    for (const element of this.a) {
      const numb = available.has(element) ? available.get(element) : (this.fullBCount.get(element) ?? 0)
      available.set(element, numb - 1)
      if (numb > 0) matches += 1
    }
    return calculateRatio(matches, this.a.length + this.b.length)
  }

  realQuickRatio() {
    const la = this.a.length
    const lb = this.b.length
    return calculateRatio(Math.min(la, lb), la + lb)
  }
}

function calculateRatio(matches, length) {
  return length ? (2.0 * matches) / length : 1.0
}

/** SequenceMatcher(None, a, b, autojunk=False).ratio() */
export function ratio(a, b) {
  return new SequenceMatcher(a, b).ratio()
}
