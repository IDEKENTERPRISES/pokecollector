// Pure helpers for the small delights (engagement P8): On this day, Showcase 6 and Collection DNA.

export const SHOWCASE_MAX = 6

export const fill = (template, values) => Object.entries(values).reduce(
  (text, [key, value]) => text.replaceAll(`{${key}}`, value),
  template,
)

/** The On this day card shows only when something was acquired on this day in an earlier year. */
export function hasOnThisDay(data) {
  return Boolean(data && Array.isArray(data.years) && data.years.length > 0)
}

/** Add or remove an id, keeping the order picked and never holding more than `max`. */
export function toggleShowcase(ids, id, max = SHOWCASE_MAX) {
  if (ids.includes(id)) return ids.filter(value => value !== id)
  return ids.length >= max ? ids : [...ids, id]
}

/** Whether the picked list differs from what is saved (order matters). */
export function showcaseChanged(saved, picked) {
  return saved.length !== picked.length || saved.some((id, i) => id !== picked[i])
}

/**
 * Donut segments for the type wheel: { type, count, share, start, end } with start/end as fractions
 * of a turn. Zero or invalid counts are dropped.
 */
export function donutSegments(types) {
  const rows = (types ?? []).filter(row => Number(row?.count) > 0)
  const total = rows.reduce((sum, row) => sum + Number(row.count), 0)
  if (total === 0) return []
  let cursor = 0
  return rows.map(row => {
    const share = Number(row.count) / total
    const segment = { type: row.type, count: Number(row.count), share, start: cursor, end: cursor + share }
    cursor += share
    return segment
  })
}

/** SVG arc path for one donut segment (a full turn is drawn as two halves). */
export function arcPath(start, end, radius = 50, inner = 32, centre = 60) {
  const point = (fraction, r) => {
    const angle = fraction * 2 * Math.PI - Math.PI / 2
    return [centre + r * Math.cos(angle), centre + r * Math.sin(angle)]
  }
  const sweep = Math.min(end, start + 0.99999)
  const large = sweep - start > 0.5 ? 1 : 0
  const [x1, y1] = point(start, radius)
  const [x2, y2] = point(sweep, radius)
  const [x3, y3] = point(sweep, inner)
  const [x4, y4] = point(start, inner)
  const f = n => n.toFixed(3)
  return `M${f(x1)} ${f(y1)}A${radius} ${radius} 0 ${large} 1 ${f(x2)} ${f(y2)}L${f(x3)} ${f(y3)}A${inner} ${inner} 0 ${large} 0 ${f(x4)} ${f(y4)}Z`
}

/** Bar widths as a percentage of the largest count, never below 4 so the smallest bar shows. */
export function barWidths(rows) {
  const max = Math.max(0, ...(rows ?? []).map(row => Number(row.count) || 0))
  return (rows ?? []).map(row => ({ ...row, width: max > 0 ? Math.max(4, Math.round(((Number(row.count) || 0) / max) * 100)) : 0 }))
}
