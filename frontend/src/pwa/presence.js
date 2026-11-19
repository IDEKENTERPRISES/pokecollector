// Tells the server whether this device has the app open, so it does not push to a phone that is already
// looking at the app. The server decides (a push that showed nothing could make iOS drop the
// subscription), this only reports. See backend/services/push.py, `is_in_foreground`.
import { getCurrentSubscription } from './push'

export const HEARTBEAT_INTERVAL_MS = 30000
const URL = '/api/push/presence'

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  try {
    const token = localStorage.getItem('token')
    if (token) headers.Authorization = `Bearer ${token}`
  } catch {
    // storage blocked: the server answers 401 and nothing changes
  }
  return headers
}

// sendBeacon cannot carry the Authorization header, so a keepalive fetch does the "background" report: it
// also survives the page closing.
async function report(state) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return
  try {
    const subscription = await getCurrentSubscription()
    if (!subscription?.endpoint) return // no push on this device: nothing to suppress
    await fetch(URL, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ endpoint: subscription.endpoint, state }),
      keepalive: true,
    })
  } catch {
    // best effort: a missed report only means the device gets a push it could have skipped
  }
}

// Starts reporting: "foreground" when the page is visible and every 30 s while it stays visible,
// "background" when it is hidden or going away. Returns a function that stops it.
export function startPresence(doc = document, win = window) {
  let timer = null

  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
  const foreground = () => {
    report('foreground')
    if (timer === null) timer = setInterval(() => report('foreground'), HEARTBEAT_INTERVAL_MS)
  }
  const background = () => {
    stopTimer()
    report('background')
  }
  const onVisibility = () => (doc.visibilityState === 'visible' ? foreground() : background())

  doc.addEventListener('visibilitychange', onVisibility)
  win.addEventListener('pagehide', background)
  win.addEventListener('beforeunload', background)
  if (doc.visibilityState === 'visible') foreground()

  return () => {
    stopTimer()
    doc.removeEventListener('visibilitychange', onVisibility)
    win.removeEventListener('pagehide', background)
    win.removeEventListener('beforeunload', background)
  }
}
