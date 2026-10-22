// Network helpers for the offline card database: every request has a deadline and a retry policy.
// On an iPhone "offline" often means requests that hang instead of failing (navigator.onLine stays
// true), so a request without a timeout can stall a whole download for good.

import { AbortedError, OfflineError } from './sync.js'

/** A download problem the UI can name. `reason`: timeout | network | server | auth | storage. */
export class PictureError extends OfflineError {
  constructor(reason, message) {
    super(message || reason)
    this.reason = reason
  }
}

export const sleepMs = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new AbortedError())
    return
  }
  const onAbort = () => {
    globalThis.clearTimeout(timer)
    reject(new AbortedError())
  }
  const timer = globalThis.setTimeout(() => {
    signal?.removeEventListener('abort', onAbort)
    resolve()
  }, ms)
  signal?.addEventListener('abort', onAbort, { once: true })
})

/**
 * Runs `fn(signal)` with a deadline. The inner signal is aborted on timeout or when `signal` aborts;
 * the result also stops waiting at once in both cases, even for a `fn` that ignores its signal.
 * Rejects with AbortedError (caller aborted) or PictureError('timeout').
 */
export async function timed(fn, timeoutMs, signal) {
  if (signal?.aborted) throw new AbortedError()
  const inner = new AbortController()
  let timedOut = false
  let timer
  let onAbort
  const stop = new Promise((_resolve, reject) => {
    timer = globalThis.setTimeout(() => {
      timedOut = true
      inner.abort()
      reject(new PictureError('timeout'))
    }, timeoutMs)
    onAbort = () => {
      inner.abort()
      reject(new AbortedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  stop.catch(() => {})
  try {
    return await Promise.race([fn(inner.signal), stop])
  } catch (error) {
    if (signal?.aborted) throw new AbortedError()
    if (timedOut) throw new PictureError('timeout')
    throw error
  } finally {
    globalThis.clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** Retries `fn` with exponential backoff; not for aborts or errors marked `retryable === false`. */
export async function retrying(fn, { attempts = 3, baseMs = 1000, maxMs = 15000, signal, sleep = sleepMs } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn(attempt)
    } catch (error) {
      if (error instanceof AbortedError || signal?.aborted) throw error instanceof AbortedError ? error : new AbortedError()
      if (error?.retryable === false || attempt + 1 >= attempts) throw error
      await sleep(Math.min(baseMs * 2 ** attempt, maxMs), signal)
    }
  }
}

/** Turns a failed fetch or a bad HTTP status into a PictureError (retryable unless 4xx). */
export function statusError(status) {
  const error = new PictureError(status === 401 ? 'auth' : 'server', `HTTP ${status}`)
  error.status = status
  error.retryable = !(status >= 400 && status < 500 && status !== 429)
  return error
}
