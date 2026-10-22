// A page that was never opened while online has nothing saved. Offline it shows its normal empty state
// and one short line (owner feedback F12), instead of a full-page "This page isn't available offline".

import { useQueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'

// Queries every page of the shell holds (the tab bar's scan badge, sync progress, small settings): they say
// nothing about whether the current page has saved data.
export const SHELL_QUERY_KEYS = new Set(['scan-jobs', 'sync-status', 'setting', 'currencies', 'exchange-rate', 'carddb'])

/**
 * True when most of what the page loads is missing: at least half of its queries hold no data. A
 * page that only lacks a query or two of its extras (everything else saved) shows no note, and a page
 * that shares one query with a page opened before (the dashboard figures, say) still shows it.
 * `queries` are the active queries (the mounted ones); the shell's own are ignored. A page with no
 * queries of its own never shows the note.
 */
export function pageHasNoSavedData(queries) {
  const page = queries.filter(query => !SHELL_QUERY_KEYS.has(String(query.queryKey?.[0])))
  if (page.length === 0) return false
  const missing = page.filter(query => query.state.data === undefined).length
  return missing > 0 && missing * 2 >= page.length
}

/** Subscribes to the query cache and answers `pageHasNoSavedData` for what is mounted now. */
export function useNotSaved() {
  const cache = useQueryClient().getQueryCache()
  return useSyncExternalStore(
    callback => cache.subscribe(callback),
    () => pageHasNoSavedData(cache.findAll({ type: 'active' })),
    () => false,
  )
}
