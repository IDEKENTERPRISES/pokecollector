import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SyncProgressBar, SyncResultNote, progressCounts, progressFraction, retryNote, stageLabelKey } from './SyncProgress'

const strings = {
  'settings.syncProgressOf': '{done} of {total}',
  'settings.syncStageCards': 'Syncing cards',
  'settings.syncStageRetrying': 'Retrying failed lookups',
  'settings.syncStillFailing': '{count} lookups still failed; they will be retried on the next sync.',
  'settings.syncRetriedOk': '{count} failed lookups were retried and went through.',
  'settings.syncStillFailingOne': '1 lookup still failed. It will be retried on the next sync.',
  'settings.syncRetriedOkOne': '1 failed lookup was retried and went through.',
  'settings.syncing': 'Syncing...',
}
const t = key => strings[key] ?? key

describe('sync progress helpers', () => {
  it('maps known stages and falls back for unknown ones', () => {
    expect(stageLabelKey('cards')).toBe('settings.syncStageCards')
    expect(stageLabelKey('retrying')).toBe('settings.syncStageRetrying')
    expect(stageLabelKey('whatever')).toBe('settings.syncing')
  })

  it('computes a clamped fraction, null while the size is unknown', () => {
    expect(progressFraction({ done: 25, total: 100 })).toBe(0.25)
    expect(progressFraction({ done: 500, total: 100 })).toBe(1)
    expect(progressFraction({ done: 0, total: 0 })).toBeNull()
    expect(progressFraction(null)).toBeNull()
  })

  it('formats "x of y" only when the size is known', () => {
    expect(progressCounts({ done: 3, total: 120 }, t)).toBe('3 of 120')
    expect(progressCounts({ done: 3, total: 0 }, t)).toBe('')
  })

  it('words the retry result: still failing wins, then recovered, else nothing', () => {
    expect(retryNote({ retry: { retried: 5, recovered: 3, still_failing: 2 } }, t)).toContain('2 lookups still failed')
    expect(retryNote({ retry: { retried: 5, recovered: 5, still_failing: 0 } }, t)).toContain('5 failed lookups')
    expect(retryNote({ retry: { retried: 1, recovered: 0, still_failing: 1 } }, t)).toBe('1 lookup still failed. It will be retried on the next sync.')
    expect(retryNote({ retry: { retried: 1, recovered: 1, still_failing: 0 } }, t)).toBe('1 failed lookup was retried and went through.')
    expect(retryNote({ retry: { retried: 0 } }, t)).toBe('')
    expect(retryNote({ retry: null }, t)).toBe('')
    expect(retryNote(null, t)).toBe('')
  })
})

describe('sync progress rendering', () => {
  it('renders the stage, the counts and a progressbar', () => {
    const html = renderToStaticMarkup(<SyncProgressBar progress={{ stage: 'cards', done: 30, total: 120 }} t={t} />)
    expect(html).toContain('Syncing cards')
    expect(html).toContain('30 of 120')
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="30"')
    expect(html).toContain('width:25%')
  })

  it('is indeterminate without a total', () => {
    const html = renderToStaticMarkup(<SyncProgressBar progress={{ stage: 'retrying', done: 0, total: 0 }} t={t} />)
    expect(html).toContain('Retrying failed lookups')
    expect(html).not.toContain('aria-valuenow')
    expect(html).not.toContain('width:')
  })

  it('renders nothing when no sync runs, and the result note only when there is one', () => {
    expect(renderToStaticMarkup(<SyncProgressBar progress={null} t={t} />)).toBe('')
    expect(renderToStaticMarkup(<SyncResultNote sync={{ retry: null }} t={t} />)).toBe('')
    expect(renderToStaticMarkup(<SyncResultNote sync={{ retry: { retried: 2, recovered: 0, still_failing: 2 } }} t={t} />))
      .toContain('retried on the next sync')
  })
})
