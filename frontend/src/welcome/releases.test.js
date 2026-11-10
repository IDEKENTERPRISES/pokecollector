import { describe, expect, it } from 'vitest'
import data from './releases.json'
import {
  RELEASE_ICONS, current, findRelease, formatReleaseDate, newerSeen, newerThan, nextRelease, planWhatsNew,
  releaseTitle, releases, resolveSeen, sheetBlocks,
} from './releases'

// A small fixture shaped like the real file, so the rules don't change with every release entry.
const rel = (id, from = id, date = id, extra = {}) => ({ id, name: id, from, date, kind: 'major', summary: '', highlights: [], details: {}, underTheHood: [], ...extra })
const FIXTURE = { releases: [rel('2026-11-20'), rel('2026-11-10'), rel('2026-10-30'), rel('2026-10-23', '2026-10-20'), rel('2026-10-19', '2026-10-18')] }

describe('the release file (docs/WELCOME_DESIGN.md §5.5)', () => {
  const entries = data.releases
  const all = [...entries, data.next].filter(Boolean)
  const texts = (release) => [
    release.name, release.summary,
    ...release.highlights.flatMap((h) => [h.title, h.text]),
    ...Object.values(release.details ?? {}).flat(),
    ...(release.underTheHood ?? []),
  ]

  it('keeps the first five releases, newest first', () => {
    expect(entries.map((r) => r.name).slice(-5)).toEqual(['Cyndaquil', 'Chikorita', 'Squirtle', 'Charmander', 'Bulbasaur'])
  })

  it('has unique ids, descending, and descending dates', () => {
    const ids = entries.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([...ids].sort().reverse())
    const dates = entries.map((r) => r.date)
    expect(dates).toEqual([...dates].sort().reverse())
    for (const r of entries) {
      expect(r.id).toMatch(/^\d{4}-\d{2}-\d{2}(\.\d+)?$/)
      expect(r.from <= r.date).toBe(true)
    }
  })

  it('has at most three highlights, each with an allowed icon, a title and a sentence', () => {
    for (const r of all) {
      expect(r.highlights.length).toBeGreaterThan(0)
      expect(r.highlights.length).toBeLessThanOrEqual(3)
      for (const h of r.highlights) {
        expect(RELEASE_ICONS).toContain(h.icon)
        expect(h.title.length).toBeGreaterThan(0)
        expect(h.text.length).toBeGreaterThan(0)
      }
    }
  })

  it('has no PR numbers, "PR", or backticks in anything a trainer reads', () => {
    for (const r of all) {
      for (const text of texts(r)) {
        expect(text).not.toMatch(/#\d+/)
        expect(text).not.toMatch(/\bPRs?\b/)
        expect(text).not.toMatch(/`/)
      }
    }
  })

  it('keeps Under the hood to five items and leaves Wrapped out of Chikorita', () => {
    for (const r of all) expect((r.underTheHood ?? []).length).toBeLessThanOrEqual(5)
    expect(texts(entries.find((r) => r.name === 'Chikorita')).join(' ')).not.toMatch(/Wrapped/)
  })

  it('has a draft only under a name no release has used', () => {
    expect(nextRelease()).toBe(data.next ?? null)
    if (data.next) expect(entries.map((r) => r.name)).not.toContain(data.next.name)
    expect(nextRelease({ releases: [], next: { name: 'Totodile' } }).name).toBe('Totodile')
    expect(nextRelease({ releases: [] })).toBeNull()
  })
})

describe('releases()', () => {
  it('lists, finds and names the current release', () => {
    expect(releases()).toBe(data.releases)
    expect(current().id).toBe(data.releases[0].id)
    expect(findRelease('2026-10-29').name).toBe('Squirtle')
    expect(findRelease('nope')).toBeNull()
  })

  it('newerThan returns the releases after an id, newest first, up to the running one', () => {
    expect(newerThan('2026-11-10', FIXTURE).map((r) => r.id)).toEqual(['2026-11-20'])
    expect(newerThan('2026-10-23', FIXTURE).map((r) => r.id)).toEqual(['2026-11-20', '2026-11-10', '2026-10-30'])
    expect(newerThan('2026-11-20', FIXTURE)).toEqual([])
    expect(newerThan('', FIXTURE)).toHaveLength(5)
    expect(newerThan(null, FIXTURE)).toHaveLength(5)
  })

  it('formats dates and titles', () => {
    expect(formatReleaseDate(rel('2026-10-30'))).toBe('30 Oct 2026')
    expect(formatReleaseDate(rel('2026-10-23', '2026-10-20'))).toBe('20–23 Oct 2026')
    expect(formatReleaseDate(rel('2026-11-02', '2026-10-30'))).toBe('30 Oct–2 Nov 2026')
    expect(releaseTitle({ ...rel('2026-11-04'), name: 'Venusaur', nameDate: true })).toBe('Venusaur · 4 Nov')
    expect(releaseTitle({ ...rel('2026-11-04'), name: 'Bayleef' })).toBe('Bayleef')
  })

  it('folds the oldest blocks past five', () => {
    const many = Array.from({ length: 8 }, (_, i) => rel(`2026-12-0${8 - i}`))
    expect(sheetBlocks(many).shown).toHaveLength(5)
    expect(sheetBlocks(many).shown[0].id).toBe('2026-12-08')
    expect(sheetBlocks(many).folded).toBe(3)
    expect(sheetBlocks(many.slice(0, 5)).folded).toBe(0)
  })
})

describe('the since: marker (existing accounts, §5.5)', () => {
  it('resolves to the newest release whose `from` is on or before that date', () => {
    expect(resolveSeen('since:2026-11-12', FIXTURE)).toBe('2026-11-10')
    expect(resolveSeen('since:2026-11-10', FIXTURE)).toBe('2026-11-10')
    expect(resolveSeen('since:2026-10-21', FIXTURE)).toBe('2026-10-23') // inside Charmander's 20–23 Oct
    expect(resolveSeen('since:2026-10-18', FIXTURE)).toBe('2026-10-19')
    expect(resolveSeen('since:2027-01-01', FIXTURE)).toBe('2026-11-20')
  })

  it('resolves to "before the first release" when the last activity predates it', () => {
    expect(resolveSeen('since:2026-10-17', FIXTURE)).toBe('')
    expect(resolveSeen('since:2026-10-17')).toBe('')
  })

  it('leaves real ids alone and ignores junk', () => {
    expect(resolveSeen('2026-10-30', FIXTURE)).toBe('2026-10-30')
    expect(resolveSeen('2026-10-30.2', FIXTURE)).toBe('2026-10-30.2')
    for (const junk of [null, undefined, '', 'latest', 'since:soon', 5]) expect(resolveSeen(junk, FIXTURE)).toBeNull()
  })

  it('shows everything newer than the resolved release, then the real id gets written', () => {
    const plan = planWhatsNew({ serverSeen: 'since:2026-11-12', localSeen: null, source: FIXTURE })
    expect(plan.action).toBe('show')
    expect(plan.missed.map((r) => r.id)).toEqual(['2026-11-20'])
  })

  it('shows every release to someone last seen before the first release', () => {
    const plan = planWhatsNew({ serverSeen: 'since:2026-10-17', localSeen: null, source: FIXTURE })
    expect(plan.action).toBe('show')
    expect(plan.missed).toHaveLength(5)
  })

  it('shows nothing but saves the running id for a marker that is already current', () => {
    const plan = planWhatsNew({ serverSeen: 'since:2026-11-25', localSeen: null, source: FIXTURE })
    expect(plan).toMatchObject({ action: 'sync', missed: [] })
  })
})

describe('the seen rules (§5.5)', () => {
  it('a new account (nothing saved anywhere) is initialised and shown nothing', () => {
    expect(planWhatsNew({ serverSeen: null, localSeen: null, source: FIXTURE }).action).toBe('init')
    expect(planWhatsNew({ serverSeen: undefined, localSeen: null, source: FIXTURE }).action).toBe('init')
  })

  it('shows every release newer than the saved one', () => {
    const plan = planWhatsNew({ serverSeen: '2026-10-30', localSeen: null, source: FIXTURE })
    expect(plan.action).toBe('show')
    expect(plan.missed.map((r) => r.id)).toEqual(['2026-11-20', '2026-11-10'])
  })

  it('shows nothing when the account is up to date', () => {
    expect(planWhatsNew({ serverSeen: '2026-11-20', localSeen: '2026-11-20', source: FIXTURE }).action).toBe('none')
  })

  it('shows nothing when the saved id is newer than this build (a device not yet updated)', () => {
    const plan = planWhatsNew({ serverSeen: '2026-12-01', localSeen: null, source: FIXTURE })
    expect(plan).toMatchObject({ action: 'ahead', missed: [] })
  })

  it('the newer of the server and device copies wins', () => {
    expect(newerSeen('2026-10-30', '2026-11-10')).toBe('2026-11-10')
    expect(newerSeen('2026-11-10', '2026-10-30')).toBe('2026-11-10')
    expect(newerSeen(null, '2026-10-30')).toBe('2026-10-30')
    expect(newerSeen('2026-10-30', null)).toBe('2026-10-30')
    expect(newerSeen(null, null)).toBeNull()
    // An offline dismissal on this device beats the server's older copy...
    expect(planWhatsNew({ serverSeen: '2026-10-30', localSeen: '2026-11-20', source: FIXTURE }).action).toBe('sync')
    // ...and a dismissal on another device beats this device's older copy.
    expect(planWhatsNew({ serverSeen: '2026-11-20', localSeen: '2026-10-30', source: FIXTURE }).action).toBe('none')
  })

  it('a device whose copy is ahead of a failed server write retries it (sync)', () => {
    expect(planWhatsNew({ serverSeen: '2026-11-10', localSeen: '2026-11-20', source: FIXTURE }).action).toBe('sync')
  })

  it('a marker on the server is beaten by a newer real id on the device', () => {
    const plan = planWhatsNew({ serverSeen: 'since:2026-10-25', localSeen: '2026-11-10', source: FIXTURE })
    expect(plan.missed.map((r) => r.id)).toEqual(['2026-11-20'])
  })
})
