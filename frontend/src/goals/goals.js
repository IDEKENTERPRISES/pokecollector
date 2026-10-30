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
