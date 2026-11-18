import { useState } from 'react'
import { GitCompare } from 'lucide-react'

/**
 * "Compare options": the row picker that opens before a comparison starts, so only the rows a change affects are run.
 * The reference rows (the matching options in use, and the kept set) always run and cannot be unticked. The last
 * selection is remembered per browser. See docs/CARD_MATCH.md, "Choosing which rows to run".
 */

export const GROUP_ORDER = ['history', 'v10 kept', 'v12', 'v13 learned', 'custom']
export const GROUP_NAMES = { history: 'History', 'v10 kept': 'v10 kept set', v12: 'v12 reading options', 'v13 learned': 'v13 learned rule', custom: 'Custom model' }
const STORAGE_PREFIX = 'scanner-lab-compare-rows-'

/** The saved selection for one comparison kind, or null (nothing saved, or storage is not available). */
export function loadSelection(kind) {
  try {
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_PREFIX + kind))
    return Array.isArray(saved) ? saved.filter(label => typeof label === 'string') : null
  } catch {
    return null
  }
}

export function saveSelection(kind, labels) {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + kind, JSON.stringify(labels))
  } catch {
    // private window or blocked storage: the picker works without it
  }
}

const referenceLabels = rows => rows.filter(row => row.reference).map(row => row.label)

/** The ticked labels to start from: the saved ones that are still rows, always with the reference rows. With nothing saved: every row. */
export function normalizeSelection(rows, saved) {
  const known = new Set(rows.map(row => row.label))
  const wanted = saved ? new Set(saved.filter(label => known.has(label))) : known
  for (const label of referenceLabels(rows)) wanted.add(label)
  return rows.filter(row => wanted.has(row.label)).map(row => row.label)
}

export const selectAll = rows => rows.map(row => row.label)
export const selectNone = rows => referenceLabels(rows)

export function toggleLabel(rows, selected, label) {
  if (referenceLabels(rows).includes(label)) return normalizeSelection(rows, selected)
  const set = new Set(selected)
  if (set.has(label)) set.delete(label)
  else set.add(label)
  return normalizeSelection(rows, [...set])
}

/** What goes in the request: the ticked rows in list order (the server adds the reference rows anyway). */
export const requestLabels = (rows, selected) => normalizeSelection(rows, selected)

/** Seconds a run of the ticked rows should take from the last measured times; ``unknown`` counts rows with no time yet. */
export function estimateSeconds(rows, selected) {
  const ticked = new Set(selected)
  let seconds = 0
  let unknown = 0
  for (const row of rows) {
    if (!ticked.has(row.label)) continue
    if (row.seconds > 0) seconds += row.seconds
    else unknown += 1
  }
  return { seconds, unknown }
}

export function formatEstimate({ seconds, unknown }, count) {
  if (!seconds) return `${count} rows; no earlier timings to estimate from`
  const minutes = Math.round(seconds / 60)
  const text = minutes >= 90 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min` : `${minutes} min`
  return `${count} rows, about ${text}${unknown ? ` (${unknown} with no earlier timing not counted)` : ''}`
}

/** The picker itself, controlled: ``selected`` and ``onChange(labels)``. */
export function CompareRowPicker({ rows, selected, onChange, onRun, onCancel, busy, kind }) {
  const ticked = new Set(selected)
  const estimate = estimateSeconds(rows, selected)
  const groups = GROUP_ORDER.map(group => [group, rows.filter(row => row.group === group)]).filter(([, members]) => members.length)
  return (
    <div className="space-y-2 rounded-md bg-fill px-3 py-2.5" data-testid={`scanner-lab-picker-${kind}`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-footnote font-semibold">Rows to run</p>
        <button type="button" className="ios-press text-footnote text-tint underline" onClick={() => onChange(selectAll(rows))} data-testid={`scanner-lab-picker-all-${kind}`}>All</button>
        <button type="button" className="ios-press text-footnote text-tint underline" onClick={() => onChange(selectNone(rows))} data-testid={`scanner-lab-picker-none-${kind}`}>None</button>
      </div>
      {groups.map(([group, members]) => (
        <fieldset key={group} className="space-y-1">
          <legend className="text-caption1 uppercase tracking-wide text-text-secondary">{GROUP_NAMES[group] || group}</legend>
          {members.map(row => (
            <label key={row.label} className="flex items-start gap-2 text-footnote" data-testid={`scanner-lab-picker-row-${row.label}`}>
              <input
                type="checkbox" className="mt-0.5" checked={ticked.has(row.label) || Boolean(row.reference)} disabled={Boolean(row.reference) || busy}
                onChange={() => onChange(toggleLabel(rows, selected, row.label))}
              />
              <span>
                {row.title}
                {row.reference && <span className="text-text-secondary"> · always runs (reference)</span>}
                {row.seconds > 0 && <span className="text-text-secondary"> · last {Math.max(1, Math.round(row.seconds / 60))} min</span>}
              </span>
            </label>
          ))}
        </fieldset>
      ))}
      <p className="text-footnote text-text-secondary" data-testid={`scanner-lab-picker-estimate-${kind}`}>{formatEstimate(estimate, selected.length)}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ios-press inline-flex items-center gap-1.5 rounded-full bg-tint px-3 py-1.5 text-footnote font-semibold text-white disabled:opacity-50" disabled={busy} onClick={onRun} data-testid={`scanner-lab-picker-run-${kind}`}>
          <GitCompare size={13} aria-hidden="true" /> Run {selected.length} {selected.length === 1 ? 'row' : 'rows'}
        </button>
        <button type="button" className="ios-press rounded-full px-3 py-1.5 text-footnote text-text-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

/** The button that opens the picker, and the picker. ``onRun(labels)`` starts the comparison. */
export default function ComparePicker({ rows, kind, buttonText, disabled, busy, onRun, buttonClassName, testId }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(() => normalizeSelection(rows, loadSelection(kind)))
  const change = labels => {
    const next = normalizeSelection(rows, labels)
    setSelected(next)
    saveSelection(kind, next)
  }
  const ticked = normalizeSelection(rows, selected)
  return (
    <>
      <button type="button" className={buttonClassName} disabled={disabled} aria-expanded={open} onClick={() => setOpen(value => !value)} data-testid={testId}>
        <GitCompare size={13} aria-hidden="true" /> {buttonText}
      </button>
      {open && (
        <div className="basis-full">
          <CompareRowPicker
            rows={rows} kind={kind} selected={ticked} busy={Boolean(busy)} onChange={change} onCancel={() => setOpen(false)}
            onRun={() => { setOpen(false); onRun(requestLabels(rows, ticked)) }}
          />
        </div>
      )}
    </>
  )
}
