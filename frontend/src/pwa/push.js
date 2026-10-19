// Web push for price alerts, page side (docs/PWA_OFFLINE_DESIGN.md §6.7.2).
import { getVapidPublicKey, subscribePush, unsubscribePush } from '../api/client'

const READY_TIMEOUT_MS = 10000

// True when this browser can subscribe. On iPhone that is only the case in the installed app.
export function pushSupported() {
  return typeof window !== 'undefined'
    && Boolean(window.isSecureContext)
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
}

// iPhone Safari tab: no PushManager yet, but the user can install the app and then enable push.
export function isIosBrowserTab() {
  return typeof window !== 'undefined' && Boolean(window.isSecureContext) && navigator.standalone === false
}

export function pushPermission() {
  return typeof Notification === 'undefined' ? 'default' : Notification.permission
}

function urlBase64ToUint8Array(value) {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4)
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, char => char.charCodeAt(0))
}

async function readyRegistration() {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('service worker not ready')), READY_TIMEOUT_MS)
  })
  return Promise.race([navigator.serviceWorker.ready, timeout])
}

export async function getCurrentSubscription() {
  if (!pushSupported()) return null
  try {
    const registration = await readyRegistration()
    return await registration.pushManager.getSubscription()
  } catch {
    return null
  }
}

function toPayload(subscription) {
  const json = subscription.toJSON()
  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth },
    user_agent: (navigator.userAgent || '').slice(0, 255),
  }
}

// Must run inside a click handler: iOS only shows the permission prompt for a user gesture.
// Resolves { ok: true } or { ok: false, reason: 'unsupported' | 'denied' | 'failed' }.
export async function enablePush() {
  if (!pushSupported()) return { ok: false, reason: 'unsupported' }
  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return { ok: false, reason: 'denied' }
    const registration = await readyRegistration()
    let subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      const { public_key: publicKey } = await getVapidPublicKey()
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })
    }
    await subscribePush(toPayload(subscription))
    return { ok: true }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

export async function disablePush() {
  const subscription = await getCurrentSubscription()
  if (!subscription) return { ok: true }
  const { endpoint } = subscription
  try {
    await unsubscribePush(endpoint)
    await subscription.unsubscribe()
    return { ok: true }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}
