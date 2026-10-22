// Going offline while the app is open (owner feedback F11). A session that started online never
// restored the saved read cache, and a page opened in Airplane Mode left its fetch hanging for ever.
// These helpers carry the decisions so they can be unit-tested; OfflineProvider wires them up.

/**
 * Turns the stream of "is the banner up?" values into one event per offline episode: 'start' on the
 * first offline value after an online one, 'end' on the first online value after an episode, null otherwise.
 */
export function createOfflineEpisodes() {
  let offline = false
  return {
    update(isOffline) {
      const next = Boolean(isOffline)
      if (next === offline) return null
      offline = next
      return next ? 'start' : 'end'
    },
    isOffline: () => offline,
  }
}

/**
 * Stops the fetches that can only hang: in flight, and with nothing to show yet. The data-less query
 * goes back to idle (a page then shows its normal empty or offline state instead of a spinner) and
 * refetches when the connection is back. Queries that hold data keep their fetch.
 * → the number of fetches cancelled.
 */
export function cancelHungQueries(queryClient) {
  const hung = queryClient.getQueryCache().findAll({
    predicate: query => query.state.data === undefined && query.state.fetchStatus === 'fetching',
  })
  hung.forEach(query => { query.cancel({ revert: true }).catch(() => {}) })
  return hung.length
}

/** Back online: every mounted query asks the server again, and the restored copies are replaced. */
export function refreshAfterReconnect(queryClient) {
  return queryClient.invalidateQueries({ type: 'active' })
}
