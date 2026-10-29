// Achievement helpers (engagement P6): the eight gym-badge tracks, their tiers and the unlock queue.
// Pure functions, so the rules are tested without a browser.

export const TRACKS = ['collection', 'sets', 'value', 'pokedex', 'variety', 'explorer', 'trader', 'daily']
export const TIERS = ['bronze', 'silver', 'gold']

// One type colour per track, so the badge case reads like a gym badge case.
export const TRACK_TYPE = {
  collection: 'grass',
  sets: 'water',
  value: 'lightning',
  pokedex: 'fire',
  variety: 'psychic',
  explorer: 'fighting',
  trader: 'dragon',
  daily: 'fairy',
}

export const TIER_TINT = { bronze: '#CD7F32', silver: '#C9D1DB', gold: '#FFCB05' }

export const trackLabelKey = track => `achievements.track.${track}`
export const tierLabelKey = tier => `achievements.tier.${tier}`

/**
 * The eight gym badges from the server's `tracks` summary: [{ track, tier }] in track order.
 * A track is lit by its highest earned tier; `tier` is null when nothing in it is earned.
 */
export function gymBadgeStates(tracks) {
  const byTrack = new Map((Array.isArray(tracks) ? tracks : []).map(row => [row?.track, row]))
  return TRACKS.map((track) => {
    const tier = byTrack.get(track)?.tier
    return { track, tier: TIERS.includes(tier) ? tier : null }
  })
}

/** Tracks in display order with their achievements, keeping the server's order inside a track. */
export function groupByTrack(achievements) {
  const groups = new Map(TRACKS.map(track => [track, []]))
  for (const item of achievements ?? []) {
    if (groups.has(item.track)) groups.get(item.track).push(item)
  }
  return TRACKS.map(track => ({ track, items: groups.get(track) })).filter(group => group.items.length > 0)
}

/** Adds newly fetched unlocks to the queue, oldest first, skipping ones queued or already handled. */
export function mergeQueue(queue, incoming, handled = new Set()) {
  const known = new Set(queue.map(item => item.id))
  const added = (incoming ?? []).filter(item => item?.id && !known.has(item.id) && !handled.has(item.id))
  return added.length === 0 ? queue : [...queue, ...added]
}

/**
 * The unseen response as one list for the unlock queue: badges first, then completed quests (each
 * with a `kind`, and quests with an `id` of "quest:<date>:<quest id>" so the two never collide).
 */
export function unseenItems(response) {
  const badges = (response?.unlocks ?? []).filter(item => item?.id).map(item => ({ ...item, kind: 'badge' }))
  const quests = (response?.quests ?? []).filter(item => item?.key && item?.quest_id).map(item => ({
    ...item, kind: 'quest', id: `quest:${item.key}`,
  }))
  return [...badges, ...quests]
}

/**
 * Whether the app is in the middle of something the unlock sheet must not interrupt: the scan
 * screens, or any other open dialog (a sheet, the camera, an alert). The unlock sheet itself,
 * marked `data-unlock-sheet`, does not count.
 */
export function isBusy(doc, pathname = '') {
  if (/^\/scans(\/|$)/.test(pathname)) return true
  const dialogs = doc?.querySelectorAll?.('[role="dialog"][aria-modal="true"]') ?? []
  return Array.from(dialogs).some(dialog => !dialog.querySelector?.('[data-unlock-sheet]'))
}
