// Chase goals (engagement P10): small helpers shared by the Goals screen, the detail page and Home.

export const GOAL_KINDS = ['set', 'set_master', 'generation', 'family', 'artist', 'custom']

export const KIND_LABEL_KEYS = {
  set: 'goals.kindSet',
  set_master: 'goals.kindSetMaster',
  generation: 'goals.kindGeneration',
  family: 'goals.kindFamily',
  artist: 'goals.kindArtist',
  custom: 'goals.kindCustom',
}

export const goalPercent = goal => {
  const percent = Number(goal?.progress?.percent)
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0
}

/** Whole percent for the ring label; never rounds an unfinished goal up to 100. */
export const wholePercent = percent => {
  const value = Number(percent) || 0
  return value >= 100 ? 100 : Math.min(99, Math.floor(value))
}

export const isGoalComplete = goal => Boolean(goal?.progress?.total) && goal.progress.missing === 0

export const pinnedGoals = goals => (Array.isArray(goals) ? goals.filter(goal => goal.pinned) : [])

/** The set / list goals' route target for a row of the picker (a set row from /api/sets). */
export const setGoalParams = set => ({ set_id: set.tcg_set_id || String(set.id).replace(/_[a-z-]+$/i, ''), lang: set.lang || 'en' })

export const goalsQueryKey = userId => ['goals', userId]
export const goalQueryKey = (userId, goalId) => ['goal', userId, String(goalId)]

export const FAMILY_RESULT_CAP = 60

/** Lower-case, accent-folded text for searching (Pokémon -> pokemon). */
export function foldText(text) {
  return String(text ?? '').toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '').trim()
}

/**
 * Narrow the family list to a search. A family matches when any member's English or German name contains
 * the text; names starting with it come first, then the popular families, then the Pokédex order the list is in.
 * Without a query the popular families come first. Each result says which members matched.
 */
export function filterFamilies(families, query, cap = FAMILY_RESULT_CAP) {
  const list = Array.isArray(families) ? families : []
  const needle = foldText(query)
  if (!needle) {
    const ordered = [...list.filter(f => f.popular), ...list.filter(f => !f.popular)]
    return { items: ordered.slice(0, cap).map(family => ({ family, matched: [] })), total: ordered.length }
  }
  const hits = []
  list.forEach((family, position) => {
    const matched = []
    let prefix = false
    for (const member of family.members || []) {
      const names = [foldText(member.name), foldText(member.name_de)]
      if (names.some(name => name.includes(needle))) {
        matched.push(member.dex_id)
        prefix = prefix || names.some(name => name.startsWith(needle))
      }
    }
    if (matched.length) hits.push({ family, matched, rank: prefix ? 0 : 1, position })
  })
  hits.sort((a, b) => a.rank - b.rank || a.position - b.position)
  return { items: hits.slice(0, cap).map(({ family, matched }) => ({ family, matched })), total: hits.length }
}

/** The goal params for a picked family: one of each Pokémon, or every print. */
export function familyGoalParams(family, scope) {
  return scope === 'every' ? { family: family.id, every: true } : { family: family.id }
}
