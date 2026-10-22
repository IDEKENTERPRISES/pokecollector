// A tiny bus: the API client reports requests that failed without any response (network error,
// timeout) and the reachability monitor listens. Kept free of imports so client.js stays light.

const listeners = new Set()

export function notifyNetworkFailure() {
  listeners.forEach(cb => {
    try {
      cb()
    } catch {
      // a listener must never break the request that failed
    }
  })
}

export function onNetworkFailure(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// A request that gets no answer for a while hints at a dead connection even though nothing failed
// yet: on iPhone, Airplane Mode leaves requests hanging until the 30 s axios timeout. After
// SLOW_REQUEST_HINT_MS the monitor is asked to check (a quick health probe). The request itself is
// never cancelled, and a reachable-but-slow server is not offline: only failed probes show the banner.
export const SLOW_REQUEST_HINT_MS = 5000

export function startSlowRequestHint(config, {
  ms = SLOW_REQUEST_HINT_MS,
  setTimer = (fn, delay) => globalThis.setTimeout(fn, delay),
  notify = notifyNetworkFailure,
} = {}) {
  if (!config) return
  config.__slowRequestHint = setTimer(() => {
    config.__slowRequestHint = null
    notify()
  }, ms)
}

export function endSlowRequestHint(config, clearTimer = id => globalThis.clearTimeout(id)) {
  if (config?.__slowRequestHint != null) {
    clearTimer(config.__slowRequestHint)
    config.__slowRequestHint = null
  }
}
