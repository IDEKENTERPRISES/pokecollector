import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import en from '../../i18n/en'

const t = key => key.split('.').reduce((node, part) => node?.[part], en) ?? key
const mocks = vi.hoisted(() => ({ user: { role: 'user' }, db: null }))

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: mocks.user }) }))
vi.mock('../../contexts/SettingsContext', () => ({ useSettings: () => ({ t }) }))
vi.mock('../../offline/carddb/useCardDb', () => ({ useCardDb: () => mocks.db }))
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: { running: false, total: 21990, cached: 21979 } }),
  useMutation: () => ({ mutate: () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}))

const { default: OfflineCardDbSection, ServerPicturesSection } = await import('./OfflineCardDbSection')

const snapshot = (overrides = {}) => ({
  supported: true,
  serverEnabled: true,
  available: ['en'],
  status: 'idle',
  progress: null,
  storageOk: true,
  checkedAt: Date.now(),
  prefs: { enabled: true, languages: {}, pictures: {} },
  languages: { en: { bytes: 5000, meta: { syncedAt: Date.now(), cards: 12, pricesUpdatedAt: null }, pictures: { status: 'none', totalSets: 1 } } },
  actions: { inspectPictures: () => Promise.resolve(), resumeStalledPictures: () => {} },
  ...overrides,
})

describe('offline card database on Sync & offline', () => {
  beforeEach(() => {
    mocks.user = { role: 'user' }
    mocks.db = snapshot()
  })

  it('shows the switch, languages, pictures and Remove to a trainer, without the server row', () => {
    const markup = renderToStaticMarkup(createElement(OfflineCardDbSection))
    for (const id of ['carddb-section', 'carddb-enabled', 'carddb-language-en', 'carddb-pictures-row-en', 'carddb-remove']) {
      expect(markup).toContain(`data-testid="${id}"`)
    }
    expect(markup).not.toContain('carddb-prepare-row')
    expect(renderToStaticMarkup(createElement(ServerPicturesSection))).toBe('')
  })

  it('shows the server picture counts to an admin only', () => {
    mocks.user = { role: 'admin' }
    const markup = renderToStaticMarkup(createElement(ServerPicturesSection))
    expect(markup).toContain('On the server: 21,979 of 21,990 pictures ready · 11 couldn&#x27;t be fetched')
  })

  it('shows the re-download notice only when the flag is set', () => {
    expect(renderToStaticMarkup(createElement(OfflineCardDbSection))).not.toContain('carddb-redownload-notice')
    mocks.db = snapshot({ picturesNeedRedownload: true })
    expect(renderToStaticMarkup(createElement(OfflineCardDbSection))).toContain('carddb-redownload-notice')
  })
})
