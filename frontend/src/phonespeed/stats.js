/** Median of a list of numbers (null when empty). */
export function median(values) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = sorted.length >> 1
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Time one async or sync step: [first run, median of `runs` runs (the first counts), all runs], in milliseconds. */
export async function timeRuns(step, runs = 5, now = () => performance.now()) {
  const times = []
  let last
  for (let i = 0; i < runs; i++) {
    const start = now()
    last = await step(i)
    times.push(now() - start)
  }
  return { first: times[0], median: median(times), runs: times, last }
}

export const round = (value, digits = 1) => (value === null || value === undefined || !Number.isFinite(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits)
