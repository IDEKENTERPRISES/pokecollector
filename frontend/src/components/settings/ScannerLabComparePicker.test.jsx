import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  CompareRowPicker, estimateSeconds, formatEstimate, loadSelection, normalizeSelection, requestLabels, saveSelection, selectAll, selectNone, toggleLabel,
} from './ScannerLabComparePicker'
import { CompareTable } from './ScannerLabSection'

const rows = [
  { label: 'baseline', title: 'Baseline (picture only)', group: 'history', reference: false, seconds: 600 },
  { label: 'kept', title: 'Kept set', group: 'v10 kept', reference: true, seconds: 1200 },
  { label: 'kept+widefirst', title: 'Kept set + widefirst', group: 'v12', reference: false, seconds: 1800 },
  { label: 'kept+topname', title: 'Kept set + topname', group: 'v12', reference: false, seconds: null },
  { label: 'kept+custom', title: 'Kept set + custom', group: 'custom', reference: false, seconds: 900 },
]
const noop = () => {}
const view = (selected, props = {}) => renderToStaticMarkup(<CompareRowPicker rows={rows} kind="labelled" selected={selected} busy={false} onChange={noop} onRun={noop} onCancel={noop} {...props} />)

describe('Scanner lab: compare row picker', () => {
  it('groups the rows with readable titles and disables the reference rows, marked as always running', () => {
    const html = view(['kept'])
    expect(html).toContain('v10 kept set')
    expect(html).toContain('v12 reading options')
    expect(html).toContain('Custom model')
    expect(html).toContain('Kept set + widefirst')
    expect(html).toContain('always runs (reference)')
    const reference = html.slice(html.indexOf('scanner-lab-picker-row-kept"'), html.indexOf('scanner-lab-picker-row-kept+widefirst'))
    expect(reference).toContain('disabled')
    expect(reference).toContain('checked')
    const other = html.slice(html.indexOf('scanner-lab-picker-row-baseline'), html.indexOf('scanner-lab-picker-row-kept"'))
    expect(other).not.toContain('disabled')
    expect(other).not.toContain('checked')
  })

  it('All ticks every row and None leaves only the reference rows', () => {
    expect(selectAll(rows)).toEqual(rows.map(row => row.label))
    expect(selectNone(rows)).toEqual(['kept'])
  })

  it('toggles a row, keeps the list order, and never unticks a reference row', () => {
    expect(toggleLabel(rows, ['kept'], 'kept+custom')).toEqual(['kept', 'kept+custom'])
    expect(toggleLabel(rows, ['kept', 'kept+custom'], 'baseline')).toEqual(['baseline', 'kept', 'kept+custom'])
    expect(toggleLabel(rows, ['kept', 'baseline'], 'baseline')).toEqual(['kept'])
    expect(toggleLabel(rows, ['kept', 'baseline'], 'kept')).toEqual(['baseline', 'kept'])
  })

  it('sends the ticked rows, with the reference rows, in list order', () => {
    expect(requestLabels(rows, ['kept+custom', 'baseline'])).toEqual(['baseline', 'kept', 'kept+custom'])
    expect(requestLabels(rows, [])).toEqual(['kept'])  // never an empty request
    expect(requestLabels(rows, ['gone-row'])).toEqual(['kept'])  // a saved row that no longer exists is dropped
  })

  it('starts with every row ticked when nothing was saved, and with the saved rows otherwise', () => {
    expect(normalizeSelection(rows, null)).toEqual(rows.map(row => row.label))
    expect(normalizeSelection(rows, ['kept+topname'])).toEqual(['kept', 'kept+topname'])
  })

  it('estimates the run time from the last measured times and says when some rows have none', () => {
    expect(estimateSeconds(rows, ['kept', 'baseline'])).toEqual({ seconds: 1800, unknown: 0 })
    expect(estimateSeconds(rows, ['kept', 'kept+topname'])).toEqual({ seconds: 1200, unknown: 1 })
    expect(formatEstimate({ seconds: 1800, unknown: 0 }, 2)).toBe('2 rows, about 30 min')
    expect(formatEstimate({ seconds: 6600, unknown: 1 }, 5)).toContain('1 h 50 min')
    expect(formatEstimate({ seconds: 6600, unknown: 1 }, 5)).toContain('1 with no earlier timing')
    expect(formatEstimate({ seconds: 0, unknown: 3 }, 3)).toContain('no earlier timings')
    expect(view(['kept', 'baseline'])).toContain('2 rows, about 30 min')
  })

  it('shows the run button with the row count and disables the checkboxes and run while busy', () => {
    expect(view(['kept', 'baseline'])).toContain('Run 2 rows')
    expect(view(['kept'])).toContain('Run 1 row')
    const busy = view(['kept'], { busy: true })
    expect(busy.match(/disabled/g).length).toBeGreaterThanOrEqual(rows.length + 1)
  })

  it('reads and writes the saved selection without throwing when storage is not available', () => {
    expect(loadSelection('labelled')).toBeNull()  // no window in the unit test environment
    expect(() => saveSelection('labelled', ['kept'])).not.toThrow()
  })
})

describe('Scanner lab: a partial comparison table', () => {
  const ok = (label, extra = {}) => ({ label, status: 'ok', n: 280, top1: 70, top20: 96, number_exact: 60, decided: 72.1, decided_wrong: 0, p95_ms: 1400, ...extra })
  const report = {
    kind: 'compare-labelled', n: 280, created_at: '2026-11-18T10:00:00+00:00', duration_seconds: 3000, winner: 'kept',
    rows: [ok('kept', { reference: true })],
    previous_rows: [
      { ...ok('baseline', { decided: 10 }), status: 'previous', date: '2026-11-10T08:00:00+00:00', same_scans: true },
      { ...ok('kept+widefirst', { decided: 73 }), status: 'previous', date: '2026-11-12T08:00:00+00:00', same_scans: false },
    ],
    selected_labels: [], reference_labels: ['kept'], not_run: ['baseline', 'kept+widefirst', 'kept+custom'],
  }

  it('greys earlier rows with their date, badges different scans, and says the winner was picked among the rows run now', () => {
    const html = renderToStaticMarkup(<CompareTable report={report} title="Option comparison" order={['baseline', 'kept', 'kept+widefirst', 'kept+custom']} />)
    expect(html.match(/scanner-lab-row-previous"/g)).toHaveLength(2)
    expect(html).toContain('previous run, 2026-11-10')
    expect(html).toContain('previous run, 2026-11-12')
    expect(html.match(/different scans/g)).toHaveLength(1)
    expect(html).toContain('not run, no earlier result')
    expect(html).toContain('picked among the rows run now')
    expect(html).toContain('reference')
    expect(html.indexOf('Picture only')).toBeLessThan(html.indexOf('wide bottom read first'))  // the full list's order
  })

  it('looks as before for a report that ran every row', () => {
    const html = renderToStaticMarkup(<CompareTable report={{ ...report, previous_rows: undefined, not_run: undefined }} title="Option comparison" />)
    expect(html).not.toContain('previous run')
    expect(html).not.toContain('picked among')
  })
})
