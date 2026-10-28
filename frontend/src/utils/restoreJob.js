// Polls the background restore job (GET /backup/restore/status) until it ends.
//
// A full restore can take many minutes, so the upload only starts it. While the database is
// being replaced the server may answer slowly or not at all, so a failed poll is retried
// instead of being treated as a failed restore.

export const RESTORE_POLL_INTERVAL_MS = 3000
export const RESTORE_MAX_CONSECUTIVE_POLL_FAILURES = 40

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const isAuthError = (error) => [401, 403].includes(error?.response?.status)

/**
 * Resolves with the final status ({ state: 'done' | 'failed' | 'idle', ... }).
 * Rejects when polling itself cannot continue (signed out, or the server stayed unreachable).
 */
export async function waitForRestore({
  fetchStatus,
  onUpdate = () => {},
  intervalMs = RESTORE_POLL_INTERVAL_MS,
  sleep = delay,
  maxFailures = RESTORE_MAX_CONSECUTIVE_POLL_FAILURES,
  isCancelled = () => false,
}) {
  let failures = 0
  while (!isCancelled()) {
    let status = null
    try {
      status = await fetchStatus()
      failures = 0
    } catch (error) {
      if (isAuthError(error)) throw error
      failures += 1
      if (failures >= maxFailures) throw error
    }
    if (status) {
      onUpdate(status)
      if (status.state !== 'running') return status
    }
    await sleep(intervalMs)
  }
  return null
}
