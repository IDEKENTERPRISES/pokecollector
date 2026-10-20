import { setImageUrl } from './imageUrl'

// Groups the cached sets list into series for the Sets screen (design doc §5.4, OD-F).
// Totals are plain sums over each series' sets, so the view works offline.

/** URL-safe slug of a series name, the series key before the sync fills series_id. */
export function slugifySeries(name) {
  const slug = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'other'
}

/** The series key of a set: its series_id when known, else a slug of the series name. */
export function seriesKeyOf(set) {
  return set?.series_id ? String(set.series_id) : slugifySeries(set?.series)
}

const yearOf = (set) => {
  const match = /^(\d{4})/.exec(set?.release_date ?? '')
  return match ? Number(match[1]) : null
}

/** "2023" or "2019 – 2023" from the sets' release dates; '' when none is known. */
export function yearsLabel(sets) {
  const years = sets.map(yearOf).filter(year => year != null)
  if (!years.length) return ''
  const first = Math.min(...years)
  const last = Math.max(...years)
  return first === last ? String(first) : `${first} – ${last}`
}

const byNewest = (a, b) => (b.release_date || '').localeCompare(a.release_date || '')

/**
 * The series logo URL. With a series_id on the sets: P6a's route. Otherwise the namesake set's
 * logo (the set whose name equals the series name), else the newest set's.
 */
export function seriesLogoSet(name, sets) {
  const newest = [...sets].sort(byNewest)
  const lower = String(name ?? '').trim().toLowerCase()
  return newest.find(set => String(set.name ?? '').trim().toLowerCase() === lower) ?? newest[0] ?? null
}

export function seriesLogoUrl(name, sets) {
  const anchor = sets.find(set => set.series_id) ?? null
  if (anchor) return setImageUrl(anchor.id, 'series')
  const fallback = seriesLogoSet(name, sets)
  return fallback ? setImageUrl(fallback.id, 'logo') : null
}

/**
 * Group sets by series. Returns [{ key, name, years, setCount, owned, total, complete, logo,
 * logoSetId, sets }] with the newest series first (by its newest release date, then name).
 * `sets` inside a group are newest first.
 */
export function groupSetsBySeries(sets = []) {
  const groups = new Map()
  for (const set of sets) {
    const key = seriesKeyOf(set)
    if (!groups.has(key)) groups.set(key, { key, name: set.series || 'Other', sets: [] })
    groups.get(key).sets.push(set)
  }
  return [...groups.values()]
    .map(group => {
      const inSeries = [...group.sets].sort(byNewest)
      const owned = inSeries.reduce((sum, set) => sum + (set.owned_count ?? 0), 0)
      const total = inSeries.reduce((sum, set) => sum + (set.total ?? 0), 0)
      const logoSet = group.sets.find(set => set.series_id) ?? seriesLogoSet(group.name, inSeries)
      return {
        key: group.key,
        name: group.name,
        years: yearsLabel(inSeries),
        setCount: inSeries.length,
        owned,
        total,
        complete: total > 0 && owned >= total,
        logo: seriesLogoUrl(group.name, inSeries),
        logoSetId: logoSet?.id ?? null,
        newest: inSeries[0]?.release_date || '',
        sets: inSeries,
      }
    })
    .sort((a, b) => b.newest.localeCompare(a.newest) || a.name.localeCompare(b.name))
}
