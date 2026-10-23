import { describe, expect, it, vi } from 'vitest'
import {
  MIGRATION_DONE_KEY, MIGRATION_NOTICE_KEY, dismissPictureMigrationNotice, migrateLegacyPictureCaches, readPictureMigrationNotice,
} from './pictureMigration.js'
import { RECORD_PREFIX } from './pictures.js'

const memoryStorage = () => {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key), values }
}

describe('picture cache migration', () => {
  it('deletes only the old picture caches, forgets their progress and leaves a notice', async () => {
    const storage = memoryStorage()
    storage.setItem(`${RECORD_PREFIX}en`, JSON.stringify({ sets: { a: { bytes: 1 } } }))
    const names = ['pc-precache-b1', 'pc-carddb-images-v1-en', 'pc-carddb-images-v1-de', 'pc-images-v1']
    const deleted = []
    const migrated = await migrateLegacyPictureCaches({
      listCaches: async () => names, deleteCache: async name => { deleted.push(name) }, storage,
    })
    expect(migrated).toEqual(['en', 'de'])
    expect(deleted).toEqual(['pc-carddb-images-v1-en', 'pc-carddb-images-v1-de'])
    expect(storage.getItem(`${RECORD_PREFIX}en`)).toBeNull()
    expect(readPictureMigrationNotice(storage)).toEqual(['en', 'de'])
    dismissPictureMigrationNotice(storage)
    expect(readPictureMigrationNotice(storage)).toEqual([])
  })

  it('runs once: after a finished run the caches are not even listed', async () => {
    const storage = memoryStorage()
    await migrateLegacyPictureCaches({ listCaches: async () => [], deleteCache: async () => {}, storage })
    expect(storage.getItem(MIGRATION_DONE_KEY)).toBe('1')
    expect(storage.getItem(MIGRATION_NOTICE_KEY)).toBeNull() // nothing to download again, so no notice
    const listCaches = vi.fn(async () => [])
    expect(await migrateLegacyPictureCaches({ listCaches, deleteCache: async () => {}, storage })).toEqual([])
    expect(listCaches).not.toHaveBeenCalled()
  })

  it('never throws, and tries again at the next start when a delete failed', async () => {
    const storage = memoryStorage()
    const migrated = await migrateLegacyPictureCaches({
      listCaches: async () => ['pc-carddb-images-v1-en'], deleteCache: async () => { throw new Error('busy') }, storage,
    })
    expect(migrated).toEqual([])
    expect(storage.getItem(MIGRATION_DONE_KEY)).toBeNull()
  })
})
