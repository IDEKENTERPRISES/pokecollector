import data from './releases.json'

/** Icons a release highlight may use (docs/WELCOME_DESIGN.md §5.5); the test checks every file entry against it. */
export const RELEASE_ICONS = Object.freeze([
  'target', 'clock', 'star', 'flame', 'award', 'book-open', 'smartphone', 'camera', 'download',
  'wifi-off', 'bell', 'users', 'trophy', 'repeat', 'layout-dashboard',
])

/** Used by the migration for accounts with no recorded activity (backend/database.py). */
export const DEFAULT_SINCE_DATE = '2026-10-17'

const MARKER = /^since:(\d{4}-\d{2}-\d{2})$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Every release, newest first. */
export function releases(source = data) {
  return source.releases
}

/** The draft of the release being tested, or null (the production build leaves it out). */
export function nextRelease(source = data) {
  return source.next ?? null
}

/** The release this build is: the first entry. */
export function current(source = data) {
  return source.releases[0] ?? null
}

/** The release with this id, or null. */
export function findRelease(id, source = data) {
  return source.releases.find((release) => release.id === id) ?? null
}

/** Releases newer than `seenId` (up to this build), newest first. '' means "before the first release". */
export function newerThan(seenId, source = data) {
  const running = current(source)?.id
  return source.releases.filter((release) => release.id > (seenId ?? '') && (!running || release.id <= running))
}

/**
 * The id a seen value stands for. A real id stays as it is; the migration's `since:YYYY-MM-DD`
 * marker becomes the newest release whose `from` is on or before that date, or '' when the
 * trainer's last visit came before the first release. Anything else (null, junk) is null.
 */
export function resolveSeen(value, source = data) {
  if (typeof value !== 'string' || !value) return null
  const marker = MARKER.exec(value)
  if (!marker) return /^\d{4}-\d{2}-\d{2}(\.\d+)?$/.test(value) ? value : null
  return source.releases.find((release) => release.from <= marker[1])?.id ?? ''
}

/** The newer of two seen values (ids sort as text), ignoring missing ones. */
export function newerSeen(a, b) {
  if (a == null) return b ?? null
  if (b == null) return a
  return a >= b ? a : b
}

/**
 * What the app does for an account at start (§5.5).
 *  - 'init': nothing saved yet (a new account): save the running id, show nothing.
 *  - 'ahead': the account has seen a release newer than this build (a device not yet updated): nothing.
 *  - 'show': releases are missing: open the sheet with them (`missed`, newest first).
 *  - 'sync': nothing to show, but the saved value isn't the running id yet (a resolved marker, or this
 *    device's copy is ahead of the server's): save the running id quietly.
 *  - 'none': up to date.
 */
export function planWhatsNew({ serverSeen, localSeen, source = data }) {
  const running = current(source)?.id
  if (!running) return { action: 'none', missed: [], seen: null }
  const server = resolveSeen(serverSeen, source)
  const local = resolveSeen(localSeen, source)
  const seen = newerSeen(server, local)
  if (seen == null) return { action: 'init', missed: [], seen: null }
  if (seen > running) return { action: 'ahead', missed: [], seen }
  const missed = newerThan(seen, source)
  if (missed.length > 0) return { action: 'show', missed, seen }
  const saved = serverSeen === running
  return { action: saved ? 'none' : 'sync', missed: [], seen }
}

/** "30 Oct 2026", or "20–23 Oct 2026" for a release that spanned days. */
export function formatReleaseDate(release) {
  const part = (iso) => {
    const [year, month, day] = iso.split('-').map(Number)
    return { year, month: MONTHS[month - 1], day }
  }
  const end = part(release.date)
  if (!release.from || release.from === release.date) return `${end.day} ${end.month} ${end.year}`
  const start = part(release.from)
  if (start.month === end.month && start.year === end.year) return `${start.day}–${end.day} ${end.month} ${end.year}`
  return `${start.day} ${start.month}–${end.day} ${end.month} ${end.year}`
}

/** The heading of a release: its name, plus the date once a line of evolutions has run out (`nameDate`). */
export function releaseTitle(release) {
  if (!release.nameDate) return release.name
  const date = formatReleaseDate(release).replace(/ \d{4}$/, '')
  return `${release.name} · ${date}`
}

/** Blocks of a missed-releases sheet: at most five, the rest folded into a count. */
export const SHEET_MAX_BLOCKS = 5
export function sheetBlocks(missed) {
  return { shown: missed.slice(0, SHEET_MAX_BLOCKS), folded: Math.max(0, missed.length - SHEET_MAX_BLOCKS) }
}
