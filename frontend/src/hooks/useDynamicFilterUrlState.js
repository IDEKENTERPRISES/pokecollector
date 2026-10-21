import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import {
  cloneFilterState,
  readFilterUrlState,
  writeFilterUrlState,
} from '../utils/filterUrlState'

// Matches a rendered URL against the URLs this hook wrote that the router has not yet
// rendered. Several keystrokes can queue several writes before the first renders; each
// must be recognised as our own, or the older URL would reset newer typed text.
export function consumePendingUrlKey(pending, urlKey) {
  const index = pending.indexOf(urlKey)
  return index === -1 ? { own: false, pending: [] } : { own: true, pending: pending.slice(index + 1) }
}

const serialize = (state) => JSON.stringify(state)

export function useDynamicFilterUrlState(definitions, { normalizeState, resetParams = [] } = {}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const definitionsRef = useRef(definitions)
  const normalizeStateRef = useRef(normalizeState)
  const resetParamsRef = useRef(resetParams)
  definitionsRef.current = definitions
  normalizeStateRef.current = normalizeState
  resetParamsRef.current = resetParams

  const readState = useCallback((params) => {
    const state = readFilterUrlState(params, definitionsRef.current)
    return normalizeStateRef.current ? normalizeStateRef.current(state) : state
  }, [])

  const [filters, setFilters] = useState(() => readState(searchParams))
  const filtersRef = useRef(filters)
  const pendingUrlKeysRef = useRef([])
  filtersRef.current = filters
  const urlKey = searchParams.toString()

  useEffect(() => {
    const { own, pending } = consumePendingUrlKey(pendingUrlKeysRef.current, urlKey)
    pendingUrlKeysRef.current = pending
    if (own) return

    const next = readState(searchParams)
    if (serialize(next) === serialize(filtersRef.current)) return
    filtersRef.current = next
    setFilters(next)
  }, [readState, searchParams, urlKey])

  const replaceFilters = useCallback((nextOrUpdater) => {
    const rawNext = typeof nextOrUpdater === 'function'
      ? nextOrUpdater(cloneFilterState(filtersRef.current))
      : nextOrUpdater
    const next = normalizeStateRef.current ? normalizeStateRef.current(rawNext) : rawNext
    filtersRef.current = next
    setFilters(next)

    const currentParams = new URLSearchParams(window.location.search)
    const nextParams = writeFilterUrlState(currentParams, definitionsRef.current, next)
    resetParamsRef.current.forEach(param => nextParams.delete(param))
    const nextUrlKey = nextParams.toString()
    if (nextUrlKey !== currentParams.toString()) {
      pendingUrlKeysRef.current = [...pendingUrlKeysRef.current, nextUrlKey]
      setSearchParams(nextParams, { replace: true })
    }
    return next
  }, [setSearchParams])

  const updateFilter = useCallback((key, value) => replaceFilters(current => ({
    ...current,
    [key]: value,
  })), [replaceFilters])

  const clearFilters = useCallback(() => replaceFilters(
    readFilterUrlState(new URLSearchParams(), definitionsRef.current),
  ), [replaceFilters])

  return {
    filters,
    updateFilter,
    replaceFilters,
    clearFilters,
    searchParams,
    setSearchParams,
  }
}
