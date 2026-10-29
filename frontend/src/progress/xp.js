// The XP bar's maths (engagement P7). The server owns the level curve (backend/services/progress/xp.py)
// and sends { xp, level, level_start, next_level_at }; this only turns that into what the bar shows.
// Pure and unit-tested.

const whole = value => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0)

/**
 * { level, into, span, remaining, percent, maxed } for the bar: XP earned inside this level, the XP
 * this level is worth, what is left to the next level, and a 0-100 fill. At the top level (no
 * `next_level_at`) the bar is full. Returns null when the server has not sent a level.
 */
export function xpProgress(info) {
  if (!info || info.level == null || !Number.isFinite(Number(info.level))) return null
  const xp = whole(info.xp)
  const start = Math.min(whole(info.level_start), xp)
  const maxed = info.next_level_at == null
  if (maxed) return { level: Number(info.level), into: xp - start, span: 0, remaining: 0, percent: 100, maxed: true }
  const end = Math.max(whole(info.next_level_at), start + 1)
  const span = end - start
  const into = Math.min(Math.max(xp - start, 0), span)
  return {
    level: Number(info.level),
    into,
    span,
    remaining: span - into,
    percent: Math.min(100, Math.max(0, Math.round((into / span) * 100))),
    maxed: false,
  }
}
