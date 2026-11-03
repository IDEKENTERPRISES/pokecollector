// Nonprod only: lets the owner open the real What's new sheet "as if" they last had an older release
// (docs/NONPROD.md). The override replaces both seen values for one start-up decision, then is cleared.
import { DEFAULT_SINCE_DATE, releases } from './releases'

const PREFIX = 'pc.whatsNew.test.'

export const testKey = (userId) => `${PREFIX}${userId}`

/** The choices, newest first: one per past release but the running one, then "before the first release". */
export function testChoices(source) {
  const list = releases(source)
  const named = list.slice(1).map((release) => ({ key: release.id, name: release.name, seen: release.id }))
  const first = list[list.length - 1]
  return [...named, { key: 'before', name: first?.name ?? null, before: true, seen: `since:${DEFAULT_SINCE_DATE}` }]
}

export function writeTestOverride(userId, seen, storage = globalThis.localStorage) {
  try {
    storage?.setItem(testKey(userId), seen)
  } catch {
    // best effort
  }
}

/** Reads and clears the override: it applies to one decision only. */
export function takeTestOverride(userId, storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem(testKey(userId)) || null
    if (value) storage.removeItem(testKey(userId))
    return value
  } catch {
    return null
  }
}
