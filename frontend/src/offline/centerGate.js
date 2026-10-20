/**
 * What the sync center page (/offline) should do (docs/PWA.md): redirect Home only when the offline
 * queue is really off (the flag is off or IndexedDB is missing), wait while the outbox is still
 * being created, and show the page once it exists. OfflineProvider builds the outbox in an effect,
 * so on the first render of a deep link or a reload `enabled` is briefly false even with the queue on.
 */
export function offlineCenterGate({ queueFlag, indexedDB, enabled }) {
  if (!queueFlag || !indexedDB) return 'redirect'
  return enabled ? 'ready' : 'wait'
}
