export const SCAN_JOBS_QUERY_KEY = ['scan-jobs']

export const isScanJobActive = job => Number(job?.active || 0) > 0

export const scanJobPollInterval = (job, intervalMs = 3000) =>
  isScanJobActive(job) ? intervalMs : false

export const scanAttentionCount = (jobs = []) =>
  jobs.reduce((total, job) => total + Number(job?.attention || 0), 0)

export const hasActiveScanJobs = (jobs = []) => jobs.some(isScanJobActive)

// The flat "everything waiting for you" list (GET /cards/recognize/queue). Jobs are only how uploads
// were cut up for sending; trainers see one list, oldest first.
export const SCAN_QUEUE_QUERY_KEY = ['scan-queue']

export const queueIsActive = queue => Number(queue?.counts?.processing || 0) > 0

/**
 * Splits the flat queue for the review flow: `ready` (something to decide, in order, starting at `startId`
 * when given), `processing` (still being recognised, reached when ready), `skipped` (put back by the
 * trainer, shown at the end). `kindOf(item)` is 'matches' | 'none' | 'waiting' | 'processing'.
 */
export function orderForReview(items, { skipped = [], startId = null } = {}, kindOf) {
  const skippedSet = new Set(skipped)
  let ready = items.filter(item => !skippedSet.has(item.id) && kindOf(item) !== 'processing')
  const start = ready.findIndex(item => item.id === startId)
  if (start > 0) ready = [...ready.slice(start), ...ready.slice(0, start)]
  return {
    ready,
    processing: items.filter(item => !skippedSet.has(item.id) && kindOf(item) === 'processing'),
    skipped: items.filter(item => skippedSet.has(item.id)),
    current: ready[0] || null,
  }
}
