// Pages read their catalogue data (sets, set checklist, card search) through useCatalogQuery: online it
// is exactly the page's own useQuery. Offline, when the page has no saved copy (F12's read cache) but the
// downloaded card database has the data, the answer comes from the database (F13b). The database
// answer is kept in the hook's own state, never in the query cache, so the read cache can't save it as
// server data (the `carddb` key stays on its deny list as a guard). A saved copy always wins (exact owned state).

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
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
  const wanted = (options.enabled ?? true) && offline && supported
  const saved = queryClient.getQueryData(options.queryKey)
  const reading = wanted && saved === undefined

  // The database read is a plain effect, not a query: it must run offline and re-run when a sync
  // finishes, and a cancelled query could be left idle (seen in WebKit). Its answers are kept
  // here, never in the query cache, so the read cache can't save them as server data.
  const argsKey = JSON.stringify(options.queryKey)
  const readRef = useRef(offlineFn)
  readRef.current = offlineFn
  const [answer, setAnswer] = useState({ key: null, data: null })
  useEffect(() => {
    if (!reading) return undefined
    let cancelled = false
    Promise.resolve()
      .then(() => readRef.current(getCardDbReader()))
      .catch(() => null)
      .then(data => {
        if (!cancelled) setAnswer({ key: argsKey, data: data ?? null })
      })
    return () => { cancelled = true }
  }, [reading, argsKey, version])
  const answered = answer.key === argsKey
  const fromDb = { isPending: !answered, data: answered ? answer.data : undefined }
  const dbHas = fromDb.data !== undefined && fromDb.data !== null
  const blocking = reading && (fromDb.isPending || dbHas)

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
