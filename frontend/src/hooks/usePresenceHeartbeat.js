import { useEffect } from 'react'
import { startPresence } from '../pwa/presence'

// While the signed-in app is mounted, tell the server whether this device is looking at it.
export function usePresenceHeartbeat() {
  useEffect(() => startPresence(), [])
}
