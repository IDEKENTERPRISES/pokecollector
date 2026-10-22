// Pages read their catalogue data (sets, set checklist, card search) through useCatalogQuery: online it
// is exactly the page's own useQuery. Offline, when the page has no saved copy (F12's read cache) but the
// downloaded card database has the data, the answer comes from the database (F13b). The database
// answer lives under its own `carddb` key, which the read cache never saves, so it is never mistaken
// for server data; a saved copy always wins (it holds the exact owned state).

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Database } from 'lucide-react'
import { useSettings } from '../../contexts/SettingsContext'
import { useOffline } from '../useOffline'
import { readPrefs } from './controller.js'
import { createCardDbReader } from './reader.js'
import { useCardDb } from './useCardDb.jsx'
import { useRegisterServing } from './serving.js'

export const CARDDB_QUERY_KEY = 'carddb'

let reader = null
/** The one reader of this tab; it answers nothing while card data is switched off on this device. */
export function getCardDbReader() {
  if (!reader) reader = createCardDbReader({ isEnabled: () => readPrefs().enabled })
  return reader
}

/**
 * `useQuery(options)` plus `offlineFn(reader)`, which reads the same data from the card database
 * (resolves null when it cannot). Returns the query result; `source` is 'carddb' when the data came
 * from the database, and `pricesUpdatedAt` then says how old the prices are.
 */
export function useCatalogQuery({ offlineFn, ...options }) {
  const offline = useOffline()
  const queryClient = useQueryClient()
  const { languages, supported } = useCardDb()
  const version = Object.entries(languages ?? {}).map(([lang, state]) => `${lang}:${state?.meta?.syncedAt ?? 0}`).join(',')
  // A finished sync changes what the database answers: drop the old answers.
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: [CARDDB_QUERY_KEY] })
  }, [queryClient, version])
  const wanted = (options.enabled ?? true) && offline && supported
  const saved = queryClient.getQueryData(options.queryKey)

  const fromDb = useQuery({
    queryKey: [CARDDB_QUERY_KEY, ...options.queryKey],
    queryFn: async () => {
      const data = await offlineFn(getCardDbReader())
      return data ?? null
    },
    enabled: wanted && saved === undefined,
    staleTime: 60 * 1000,
    retry: false,
    networkMode: 'always', // reads IndexedDB, not the network: it must run offline
  })
  const dbHas = fromDb.data !== undefined && fromDb.data !== null
  const blocking = wanted && saved === undefined && (fromDb.isPending || dbHas)

  useRegisterServing(blocking && !fromDb.isPending)
  const online = useQuery({ ...options, enabled: (options.enabled ?? true) && !blocking })
  if (!blocking) return { ...online, source: 'server', pricesUpdatedAt: null }
  if (fromDb.isPending) return { ...online, isLoading: true, isPending: true, source: 'carddb', pricesUpdatedAt: null }
  const { pricesUpdatedAt = null, ...data } = fromDb.data
  return {
    ...online,
    data: Array.isArray(fromDb.data) ? fromDb.data : data,
    status: 'success',
    isSuccess: true,
    isPending: false,
    isLoading: false,
    isFetching: false,
    isError: false,
    error: null,
    source: 'carddb',
    pricesUpdatedAt: pricesUpdatedAt ?? fromDb.data.pricesUpdatedAt ?? null,
  }
}

/** "Prices from <date>" for data that came from the card database; nothing otherwise. */
export function PricesFromNote({ source, pricesUpdatedAt, className = '' }) {
  const { t } = useSettings()
  if (source !== 'carddb') return null
  const date = pricesUpdatedAt ? new Date(pricesUpdatedAt) : null
  const shown = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : null
  return (
    <p
      role="status"
      data-testid="prices-from-note"
      className={`flex items-center gap-2 text-footnote text-text-secondary ${className}`}
    >
      <Database size={14} className="flex-shrink-0" aria-hidden="true" />
      {shown ? `${t('offlineDb.pricesFrom')} ${shown}` : t('offlineDb.pricesFrom')}
    </p>
  )
}
