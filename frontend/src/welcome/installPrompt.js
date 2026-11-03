// Other browsers (docs/WELCOME_DESIGN.md §3.7, E7): keep the browser's install offer so the tour's Install step can use it.
import { useSyncExternalStore } from 'react'

let saved = null
const listeners = new Set()
const notify = () => listeners.forEach(fn => fn())

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    saved = event
    notify()
  })
  window.addEventListener('appinstalled', () => {
    saved = null
    notify()
  })
}

function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useInstallable() {
  return useSyncExternalStore(subscribe, () => Boolean(saved), () => false)
}

/** Shows the browser's install dialog. Resolves true when the trainer accepted. */
export async function promptInstall() {
  const event = saved
  if (!event) return false
  saved = null
  notify()
  try {
    await event.prompt()
    const choice = await event.userChoice
    return choice?.outcome === 'accepted'
  } catch {
    return false
  }
}
