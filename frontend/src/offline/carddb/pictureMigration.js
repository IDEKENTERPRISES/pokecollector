// F16a migration: phones that downloaded pictures before the picture store existed have them as
// `pc-carddb-images-v1-<lang>` Cache Storage caches (about 22,000 entries each), which made every
// launch slow in WebKit. They are deleted in the background after start-up (never on the launch
// path), the language goes back to "not downloaded", and a one-line notice asks to download again
// (fast with packs). The notice is kept in localStorage until it is dismissed.

import { PICTURE_CACHE_PREFIX, createPictureRecord } from './pictures.js'

export const MIGRATION_NOTICE_KEY = 'pc-carddb-pictures-migrated-v1'
// Set once a run has gone through: the old caches are never created again, so later starts skip the check.
export const MIGRATION_DONE_KEY = 'pc-carddb-pictures-migration-done-v1'

/** The languages whose pictures were removed by the migration and not yet acknowledged. */
export function readPictureMigrationNotice(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(MIGRATION_NOTICE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter(lang => typeof lang === 'string') : []
  } catch {
    return []
  }
}

export function dismissPictureMigrationNotice(storage = globalThis.localStorage) {
  try {
    storage?.removeItem(MIGRATION_NOTICE_KEY)
  } catch {
    // nothing to do
  }
}

/**
 * Deletes the old picture caches. → the languages that were migrated (empty when there was nothing
 * to do, and then no Cache Storage entry is touched beyond listing the cache names).
 * Never throws: whatever cannot be deleted now is found again at the next start.
 */
export async function migrateLegacyPictureCaches({
  listCaches = () => globalThis.caches?.keys() ?? Promise.resolve([]),
  deleteCache = name => globalThis.caches?.delete(name),
  storage = globalThis.localStorage,
} = {}) {
  const migrated = []
  try {
    if (storage?.getItem(MIGRATION_DONE_KEY)) return migrated
    const names = (await listCaches()).filter(name => name.startsWith(PICTURE_CACHE_PREFIX))
    for (const name of names) {
      await deleteCache(name)
      const lang = name.slice(PICTURE_CACHE_PREFIX.length)
      createPictureRecord(storage, lang).clear()
      migrated.push(lang)
    }
    storage?.setItem(MIGRATION_DONE_KEY, '1')
    if (migrated.length) {
      const notice = new Set([...readPictureMigrationNotice(storage), ...migrated])
      try {
        storage?.setItem(MIGRATION_NOTICE_KEY, JSON.stringify([...notice]))
      } catch {
        // without the notice the pictures just show as not downloaded
      }
    }
  } catch {
    // best effort
  }
  return migrated
}
