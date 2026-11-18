import { warmCardMatcher } from '../api/client'

// The scanner screen opened: ask the server to load its picture matcher (after an idle spell it unloads from the GPU), so the first
// scan is not slow. Fire and forget; the server rate-limits it and does nothing when warm-up is off.
export function warmMatcher() {
  try {
    const request = warmCardMatcher()
    if (request && typeof request.catch === 'function') request.catch(() => {})
  } catch {
    // never let this affect the scanner
  }
}
