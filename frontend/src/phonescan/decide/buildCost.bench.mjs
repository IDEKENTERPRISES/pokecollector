// Estimate of what building the decide indexes costs, from a generated catalogue (not a device):
//   node src/phonescan/decide/buildCost.bench.mjs [rows=20000] [runs=3]
// Prints build time (sync and chunked), the structured-clone size of the result (v8.serialize, what postMessage moves),
// a JSON-size estimate and the heap growth. A phone is several times slower than a desktop core: read the times as a
// lower bound and the sizes as exact.
import v8 from 'node:v8'
import { buildDecideIndexes, buildDecideIndexesAsync } from './catalogue.js'
import { generateCatalogue } from './generated.js'

const count = Number(process.argv[2] || 20000)
const runs = Number(process.argv[3] || 3)
const rows = generateCatalogue(count)
const mb = bytes => `${(bytes / 1048576).toFixed(1)} MB`
const times = []
let indexes
if (global.gc) global.gc()
const heapBefore = process.memoryUsage().heapUsed
for (let run = 0; run < runs; run += 1) {
  const started = performance.now()
  indexes = buildDecideIndexes(rows)
  times.push(performance.now() - started)
}
if (global.gc) { global.gc(); console.log(`heap held by the indexes (after gc): ${mb(process.memoryUsage().heapUsed - heapBefore)}`) }
const started = performance.now()
let longest = 0
let last = performance.now()
const chunked = await buildDecideIndexesAsync(rows, { yieldFn: () => { const now = performance.now(); longest = Math.max(longest, now - last); last = performance.now(); return Promise.resolve() } })
const chunkedMs = performance.now() - started
console.log(`rows ${count}, kept ${indexes.count}, distinct names ${indexes.stats.distinctNames}, text segments ${indexes.stats.segments}, cards with text ${indexes.stats.withTexts}`)
console.log(`sync build ms: ${times.map(t => t.toFixed(0)).join(', ')}`)
console.log(`chunked build ms: ${chunkedMs.toFixed(0)} (longest slice without yielding ${longest.toFixed(0)} ms, ${chunked.count} cards)`)
console.log(`structured-clone size: ${mb(v8.serialize(indexes).length)}`)
console.log(`candidate rows ${mb(v8.serialize(indexes.candidates).length)}, names ${mb(v8.serialize(indexes.names).length)}, lookup ${mb(v8.serialize(indexes.lookup).length)}`)

// One decision on the full-size catalogue: a Float32 score vector, a damaged name, a number and body text.
import { decideCard } from './decideCard.js'
const ids = [...indexes.candidates.keys()]
const scores = new Float32Array(ids.length).map((_, row) => 0.05 + ((row * 7919) % 1000) / 2500)
const target = ids[1234]
scores[1234] = 0.9
const row = indexes.candidates.get(target)
const read = { number: row.number, total: String(row.printed_total), tokens: [], hp: null, lines: [`${row.number}/${row.printed_total}`, 'Discard an Energy card from your hand for 40 damage.'], name: row.name.slice(0, -1), numberSource: 'finder_card', numberConfidence: 0.9 }
const decide = () => decideCard({ pictureScores: { ids, scores, art: null }, read, options: { numberOnce: true, wholeStrict: true }, indexes })
decide()
const decisionTimes = []
for (let run = 0; run < 7; run += 1) { const t0 = performance.now(); decide(); decisionTimes.push(performance.now() - t0) }
console.log(`one decision (name + number + text lanes): ${decisionTimes.map(t => t.toFixed(1)).join(', ')} ms; result ${JSON.stringify(decide().reason ?? decide().mechanism)}`)
