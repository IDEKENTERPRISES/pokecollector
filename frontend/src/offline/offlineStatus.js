// What the API client needs to know about connectivity outside React (owner feedback F12). While the
// app is offline a request that changes something cannot succeed, and a mutation that waits for the
// connection would show a spinner for ever. The client refuses it at once with a short message that the
// page's own error toast shows. Requests the outbox queues are not affected: the outbox replays with
// `fetch`, and its own queue is what keeps those actions working offline.

export const DEFAULT_OFFLINE_MESSAGE = "Needs a connection. Try again when you're back online."

let serverOffline = false
let message = DEFAULT_OFFLINE_MESSAGE

/** OfflineProvider tells the client whether the offline banner is up (the shared reachability). */
export function setOfflineStatus(next) {
  serverOffline = Boolean(next)
}

export function setOfflineMessage(next) {
  message = next || DEFAULT_OFFLINE_MESSAGE
}

/** True when the banner is up or the device itself says it is offline. */
export function isOffline(win = globalThis) {
  return serverOffline || win?.navigator?.onLine === false
}

const READ_METHODS = new Set(['get', 'head', 'options'])

/** Whether an axios request must be refused now: it changes something and the app is offline. */
export function shouldRefuseOffline(config, win = globalThis) {
  const method = String(config?.method || 'get').toLowerCase()
  if (READ_METHODS.has(method) || config?.allowOffline) return false
  return isOffline(win)
}

/** The rejection for a refused request: shaped like a server answer so `error.response.data.detail` shows the message. */
export function offlineRequestError(config) {
  const error = new Error(message)
  error.isOfflineRefusal = true
  error.config = config
  error.response = { status: 0, data: { detail: message }, headers: {}, config }
  return error
}
