import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FlaskConical, GitCompare, Hammer } from 'lucide-react'
import api from '../../api/client'
import Misses from './ScannerLabMisses'

const QUERY_KEY = ['card-match-status']
const SHADOW_KEY = ['card-match-shadow']
const button = 'inline-flex min-h-[32px] flex-shrink-0 items-center gap-1.5 rounded-full bg-accent/20 px-3.5 text-subheadline font-semibold text-tint ios-press disabled:opacity-40'

const number = value => (value === null || value === undefined ? '–' : Number(value).toLocaleString())
const percent = value => (value === null || value === undefined ? '–' : `${value}%`)

function duration(seconds) {
  if (seconds === null || seconds === undefined) return null
  if (seconds < 90) return `${Math.round(seconds)} s`
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`
  return `${(seconds / 3600).toFixed(1)} h`
}

function Row({ label, value, testId }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1" data-testid={testId}>
      <span className="text-footnote text-text-secondary">{label}</span>
      <span className="text-subheadline tabular-nums">{value}</span>
    </div>
  )
}

function PassBar({ items }) {
  return (
    <ul className="space-y-1" data-testid="scanner-lab-pass-bar">
      {items.map(item => (
        <li key={item.id} className="flex items-baseline justify-between gap-3 text-footnote">
          <span className="min-w-0 flex-1">
            <span aria-hidden="true">{item.ok === null ? '·' : item.ok ? '✓' : '✗'}</span>{' '}
            <span className="sr-only">{item.ok === null ? 'not measured' : item.ok ? 'passes' : 'fails'}: </span>
            {item.label}
          </span>
          <span className="tabular-nums text-text-secondary">
            {number(item.value)} <span className="opacity-70">(need {item.target})</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

const GROUP_HEAD = (
  <tr className="text-left text-text-secondary">
    <th className="pr-2 font-normal">Group</th><th className="pr-2 font-normal">Scans</th><th className="pr-2 font-normal">Top 1</th>
    <th className="pr-2 font-normal">Top 20</th><th className="pr-2 font-normal">Decided</th><th className="font-normal">Right</th>
  </tr>
)

function GroupRow({ name, g }) {
  return (
    <tr className="tabular-nums">
      <td className="pr-2">{name}</td>
      <td className="pr-2">{g.n}</td><td className="pr-2">{percent(g.top1)}</td><td className="pr-2">{percent(g.top20)}</td>
      <td className="pr-2">{percent(g.decided)}</td><td>{percent(g.decided_right)}{g.decided_wrong ? ` (${g.decided_wrong} wrong)` : ''}</td>
    </tr>
  )
}

/** Real scans split by when they were made: the ones used for tuning, and the new ones that were not (the fair test). */
export function BatchGroups({ groups }) {
  if (!groups) return null
  return (
    <div data-testid="scanner-lab-batch-groups">
      <h4 className="text-footnote font-semibold">Used for tuning, and new scans</h4>
      <table className="w-full text-footnote">
        <thead>{GROUP_HEAD}</thead>
        <tbody>
          {groups.tuning && <GroupRow name="Used for tuning" g={groups.tuning} />}
          {groups.new && <GroupRow name="New scans, not used for tuning" g={groups.new} />}
        </tbody>
      </table>
      {!groups.new && (
        <p className="text-footnote text-text-secondary" data-testid="scanner-lab-no-new">
          No new scans yet, so there is nothing to show for them. They were not used for tuning, so once they exist they are the fair test.
        </p>
      )}
      {!groups.tuning && <p className="text-footnote text-text-secondary">No scans used for tuning in this run.</p>}
    </div>
  )
}

const REASON_NAMES = {
  rules_choice_not_close_in_picture: 'The number says one card, but its picture is not close enough',
  number_matches_several_printings: 'The number fits several printings and the picture cannot split them',
  number_not_among_picture_matches: 'The number read is on none of the close pictures',
  no_number_and_picture_not_clear: 'No number read and the picture is not clear enough',
  number_lookup_conflicts_with_name: 'The number and the name point at different cards',
  card_not_found_no_number_read: 'Card not found and no number read from it',
  no_picture_matches: 'No picture matches',
}

/** Scans where the first pick is right but nothing was decided, by reason: what holds back "decided". */
export function UndecidedReasons({ data }) {
  if (!data) return null
  const rows = [['all', 'All scans'], ['new', 'New scans, not used for tuning'], ['tuning', 'Used for tuning']].filter(([key]) => data[key]?.scans)
  return (
    <div data-testid="scanner-lab-undecided">
      <h4 className="text-footnote font-semibold">Right first pick, but not decided</h4>
      {rows.map(([key, label]) => (
        <div key={key}>
          <p className="text-footnote">{label}: {number(data[key].undecided)} of {number(data[key].first_right)} scans with the right first pick</p>
          {data[key].reasons.length > 0 && (
            <ul className="text-footnote text-text-secondary">
              {data[key].reasons.map(item => <li key={item.reason}>{item.n} · {REASON_NAMES[item.reason] || item.reason.replace(/_/g, ' ')}</li>)}
            </ul>
          )}
        </div>
      ))}
      <p className="text-footnote text-text-secondary">Only counted here; no rule was relaxed.</p>
    </div>
  )
}

/** Scans where the card was not found on the photo the matcher looks at (the fallbacks). */
export function FallbackGroups({ data }) {
  if (!data) return null
  const kinds = [['full_photo', 'Found on the full photo'], ['guide_crop', 'Read from the guide frame']]
  return (
    <div data-testid="scanner-lab-fallback">
      <h4 className="text-footnote font-semibold">When the card was not found ({number(data.scans)} scans)</h4>
      {data.scans > 0 ? (
        <table className="w-full text-footnote">
          <thead>{GROUP_HEAD}</thead>
          <tbody>
            {kinds.filter(([key]) => data.by_kind?.[key]).map(([key, label]) => <GroupRow key={key} name={label} g={data.by_kind[key]} />)}
            {data.found_on_photo && <GroupRow name="Card found normally" g={data.found_on_photo} />}
          </tbody>
        </table>
      ) : (
        <p className="text-footnote text-text-secondary">The card was found on every scan.</p>
      )}
      <p className="text-footnote text-text-secondary">
        These scans are listed under “Card not found: read by fallback” in Misses. A card found this way is only decided when a number was read from it and the picture agrees.
      </p>
    </div>
  )
}

export function Report({ report, title }) {
  const m = report.metrics
  const timings = report.timings_ms || {}
  return (
    <div className="space-y-3 border-t border-separator px-4 py-3" data-testid={`scanner-lab-report-${report.kind}`}>
      <div>
        <h3 className="text-subheadline font-semibold">{title}</h3>
        <p className="text-footnote text-text-secondary">
          {number(m.n)} photos · {report.created_at?.slice(0, 16).replace('T', ' ')} UTC · took {duration(report.duration_seconds)} · {report.host?.threads} threads on {report.host?.cpu_count} cores
        </p>
        {report.kind === 'synthetic' && (
          <p className="text-footnote text-text-secondary">{report.note}</p>
        )}
      </div>
      <PassBar items={report.pass_bar || []} />
      <div>
        <Row label="Card found" value={`${percent(m.card_found_pct)}${m.card_found_accurate_pct != null ? ` (corners right ${percent(m.card_found_accurate_pct)})` : ''}`} />
        <Row label="Right printing: top 1 / top 5 / top 20" value={`${percent(m.top1_pct)} / ${percent(m.top5_pct)} / ${percent(m.top20_pct)}`} />
        <Row label="Number read exactly" value={percent(m.number_exact_pct)} />
        {m.total_exact_pct != null && <Row label="Set total read exactly" value={percent(m.total_exact_pct)} />}
        <Row label="Decided without a model" value={percent(m.decided_pct)} />
        <Row label="Of those, right" value={`${percent(m.decided_right_pct)} (${number(m.decided_wrong)} wrong)`} />
      </div>
      {report.kind === 'labelled' && <BatchGroups groups={report.by_scan_time} />}
      {report.kind === 'labelled' && <UndecidedReasons data={report.undecided_first_right} />}
      {report.kind === 'labelled' && <FallbackGroups data={report.fallback} />}
      {report.groups && Object.keys(report.groups).length > 0 && (
        <table className="w-full text-footnote">
          <thead>
            <tr className="text-left text-text-secondary">
              <th className="font-normal">Group</th><th className="font-normal">n</th><th className="font-normal">Top 1</th><th className="font-normal">Top 20</th><th className="font-normal">Decided</th><th className="font-normal">Right</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(report.groups).map(([name, g]) => (
              <tr key={name} className="tabular-nums">
                <td>{{ trap: 'Reprint traps', holo: 'Holo / full art', plain: 'Other' }[name] || name}</td>
                <td>{g.n}</td><td>{percent(g.top1)}</td><td>{percent(g.top20)}</td><td>{percent(g.decided)}</td><td>{percent(g.decided_right)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <table className="w-full text-footnote" data-testid="scanner-lab-timings">
        <thead>
          <tr className="text-left text-text-secondary"><th className="font-normal">Stage</th><th className="font-normal">Median</th><th className="font-normal">95th</th></tr>
        </thead>
        <tbody>
          {Object.entries(timings).map(([stage, row]) => (
            <tr key={stage} className={stage === 'total' ? 'font-semibold tabular-nums' : 'tabular-nums'}>
              <td>{stage}</td><td>{row.median} ms</td><td>{row.p95} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-footnote text-text-secondary">
        Memory: {report.memory?.extra_mb != null ? `${number(report.memory.extra_mb)} MB extra (peak ${number(report.memory.peak_rss_mb)} MB)` : 'not measured on this host'}
        {' · '}Index: {number(report.index?.count)} pictures{report.index?.build_seconds != null ? `, built in ${duration(report.index.build_seconds)}` : ''}
      </p>
      {report.ollama_today && (
        <div data-testid="scanner-lab-ollama">
          <h4 className="text-footnote font-semibold">What today’s Ollama path got on the {number(report.ollama_today.n)} photos where it ran</h4>
          {report.ollama_today.not_run > 0 && (
            <p className="text-footnote text-text-secondary">{number(report.ollama_today.not_run)} more were decided by the picture first, so Ollama never saw them and they are not counted here.</p>
          )}
          <Row label="Decided" value={percent(report.ollama_today.decided_pct)} />
          <Row label="Of those, right" value={percent(report.ollama_today.decided_right_pct)} />
          <Row label="Right card among its candidates" value={percent(report.ollama_today.in_candidates_pct)} />
          <Row label="Right card ranked first" value={percent(report.ollama_today.top1_pct)} />
        </div>
      )}
      {report.side_by_side && <SideBySide data={report.side_by_side} />}
    </div>
  )
}

const OPTION_NAMES = { baseline: 'Picture only', names: 'Name search', number: 'number lookup', text: 'card text', reprint: 'reprint tie-break', tta: 'extra views', art: 'artwork', base: 'DINOv2-base', numberonce: 'one number boost', fastread: 'faster reading' }
const describeOptions = label => (label === 'baseline' ? OPTION_NAMES.baseline : label.split('+').map(word => OPTION_NAMES[word] || word).join(' + '))

/** The option sets side by side on the same photos: pick the row with the best top 20 and decided rate with 0 wrong. */
export function CompareTable({ report, title }) {
  return (
    <div className="space-y-2 border-t border-separator px-4 py-3" data-testid={`scanner-lab-${report.kind}`}>
      <div>
        <h3 className="text-subheadline font-semibold">{title}</h3>
        <p className="text-footnote text-text-secondary">
          {number(report.n)} photos · {report.created_at?.slice(0, 16).replace('T', ' ')} UTC · took {duration(report.duration_seconds)}
          {report.winner ? ` · kept: ${describeOptions(report.winner)}` : ''}
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-footnote">
          <thead>
            <tr className="text-left text-text-secondary">
              <th className="pr-2 font-normal">Options</th><th className="pr-2 font-normal">Top 1</th><th className="pr-2 font-normal">Top 20</th>
              <th className="pr-2 font-normal">Number</th><th className="pr-2 font-normal">Decided</th><th className="pr-2 font-normal">Wrong</th><th className="font-normal">p95</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map(row => (
              <tr key={row.label} className={`tabular-nums ${row.label === report.winner ? 'font-semibold' : ''}`}>
                <td className="pr-2">{describeOptions(row.label)}</td>
                {row.status === 'ok' ? (
                  <>
                    <td className="pr-2">{percent(row.top1)}</td><td className="pr-2">{percent(row.top20)}</td><td className="pr-2">{percent(row.number_exact)}</td>
                    <td className="pr-2">{percent(row.decided)}</td><td className="pr-2">{number(row.decided_wrong)}</td><td>{row.p95_ms != null ? `${number(row.p95_ms)} ms` : '–'}</td>
                  </>
                ) : (
                  <td colSpan={6} className="text-text-secondary">needs the {(row.missing_indexes || []).join(', ')} index</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const OCR_MODE_NAMES = { fixed: 'Fixed strips (old way)', detect: 'Find and read (new way)' }
const OCR_VARIANT_NAMES = { plain: 'as photographed', sharp: 'sharpened', clahe: 'local contrast', binary: 'black and white', deglare: 'glare removed' }
const RESOLUTION_NAMES = { 1024: 'Older scans: 1024 px crop', full: 'Newer scans: full resolution', guide_crop: 'Card not found: read from the guide frame', all: 'All scans' }

function OcrRows({ rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-footnote">
        <thead>
          <tr className="text-left text-text-secondary">
            <th className="pr-2 font-normal">Read</th><th className="pr-2 font-normal">Name</th><th className="pr-2 font-normal">Number</th>
            <th className="pr-2 font-normal">Total</th><th className="pr-2 font-normal">Set code</th><th className="font-normal">p95</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([key, row]) => (
            <tr key={key} className="tabular-nums">
              <td className="pr-2">{key.startsWith('variant:') ? `Band: ${OCR_VARIANT_NAMES[key.slice(8)] || key.slice(8)}` : OCR_MODE_NAMES[key] || key}</td>
              <td className="pr-2">{percent(row.name_pct)}</td><td className="pr-2">{percent(row.number_pct)}</td>
              <td className="pr-2">{percent(row.total_pct)}</td><td className="pr-2">{percent(row.set_code_pct)}</td>
              <td>{row.seconds_p95 != null ? `${number(Math.round(row.seconds_p95 * 1000))} ms` : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const STEP_LABELS = {
  'number-left-tight': 'Number: left corner strip', 'number-right-tight': 'Number: right corner strip', 'bottom-band': 'Number: whole bottom band',
  'number-left-wide': 'Number: left wide strip', 'number-right-wide': 'Number: right wide strip', 'bottom-wide': 'Number: tall band at the bottom',
  'name-line': 'Name: top strip', 'name-band': 'Name: name band', 'top-wide': 'Name: tall band at the top',
}

function StepRows({ rows, kind, never, scans }) {
  return (
    <table className="w-full text-footnote">
      <thead>
        <tr className="text-left text-text-secondary">
          <th className="pr-2 font-normal">Step, in order</th><th className="pr-2 font-normal">Run on</th>
          <th className="pr-2 font-normal">First right {kind} here</th><th className="pr-2 font-normal">Time each</th><th className="font-normal">Time in all</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.step} className="tabular-nums">
            <td className="pr-2">{STEP_LABELS[row.label] || row.label} · {OCR_VARIANT_NAMES[row.variant] || row.variant}</td>
            <td className="pr-2">{row.run}</td><td className="pr-2">{row.first_right}</td>
            <td className="pr-2">{row.mean_ms != null ? `${number(Math.round(row.mean_ms))} ms` : '–'}</td><td>{duration(row.total_seconds)}</td>
          </tr>
        ))}
        <tr className="tabular-nums text-text-secondary">
          <td className="pr-2">Never right</td><td className="pr-2">{scans}</td><td className="pr-2">{never}</td><td /><td />
        </tr>
      </tbody>
    </table>
  )
}

/** What each reading step rescues: of the scans, how many first had the right number (name) at each step, and its time. */
export function OcrSteps({ steps }) {
  const groups = Object.entries(steps || {})
  if (groups.length === 0) return null
  return (
    <div className="space-y-2" data-testid="scanner-lab-ocr-steps">
      <h4 className="text-footnote font-semibold">What each reading step rescues</h4>
      <p className="text-footnote text-text-secondary">
        The steps run in this order and stop once the number is complete and sure. “First right” counts the scans whose right answer first appeared at that step, so a step with 0 there
        saved nothing that an earlier step had not already saved. This is what decides which steps can be dropped for good.
      </p>
      {groups.map(([resolution, group]) => (
        <div key={resolution} data-testid={`scanner-lab-ocr-steps-${resolution}`}>
          <h5 className="text-footnote font-semibold">{RESOLUTION_NAMES[resolution] || resolution} ({number(group.scans)} scans)</h5>
          <StepRows rows={group.number} kind="number" never={group.never_number} scans={group.scans} />
          <StepRows rows={group.name} kind="name" never={group.never_name} scans={group.scans} />
        </div>
      ))}
    </div>
  )
}

/** The OCR check: the text reader alone on the confirmed real photos, split by the resolution it read from. */
export function OcrCheckView({ report }) {
  const groups = Object.entries(report.by_resolution || {})
  return (
    <div className="space-y-2 border-t border-separator px-4 py-3" data-testid="scanner-lab-ocr-check">
      <div>
        <h3 className="text-subheadline font-semibold">OCR check: real scans</h3>
        <p className="text-footnote text-text-secondary">
          {number(report.traces)} confirmed scans ({number(report.skipped)} skipped; not-found cards are read from the guide frame and shown as their own group) · {report.created_at?.slice(0, 16).replace('T', ' ')} UTC · took {duration(report.duration_seconds)}.
          What the reader got right against the confirmed card, before any lookup.
        </p>
      </div>
      {groups.map(([resolution, rows]) => {
        const entries = Object.entries(rows)
        return (
          <div key={resolution} data-testid={`scanner-lab-ocr-check-${resolution}`}>
            <h4 className="text-footnote font-semibold">{RESOLUTION_NAMES[resolution] || resolution} ({number(entries[0]?.[1]?.n)})</h4>
            <OcrRows rows={entries} />
          </div>
        )
      })}
      <OcrSteps steps={report.steps} />
      {(report.failures || []).length > 0 && (
        <details>
          <summary className="cursor-pointer text-footnote text-text-secondary">First {report.failures.length} scans where the name or the number was not read</summary>
          <ul className="space-y-1 pt-1 text-[11px] text-text-secondary">
            {report.failures.map(item => (
              <li key={item.trace} className="break-words">
                {item.truth.name} #{item.truth.number}{item.truth.total ? `/${item.truth.total}` : ''} ({item.resolution}, {item.height} px) · read name “{item.read.name || '–'}”, number {item.read.number ? `${item.read.number}${item.read.total ? `/${item.read.total}` : ''}` : '–'}
                {item.lines?.length ? ` · text: ${item.lines.join(' | ')}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

const RIGHT_LABEL = { matcher: 'the matcher', ollama: 'Ollama', current: 'Ollama', neither: 'neither' }

function SideBySide({ data }) {
  const view = data.recorded || data.rerun
  return (
    <div data-testid="scanner-lab-side-by-side">
      <h4 className="text-footnote font-semibold">Matcher and Ollama side by side ({number(view.n)} confirmed photos, Ollama ran on {number(view.current?.n ?? view.n)}{data.recorded ? ', matcher as recorded at scan time' : ', matcher run again now'})</h4>
      <Row label="Matcher decided / right" value={`${percent(view.matcher.decided_pct)} / ${percent(view.matcher.right_pct)}`} />
      <Row label="Ollama decided / right" value={`${percent(view.current.decided_pct)} / ${percent(view.current.right_pct)}`} />
      <Row label="Both decided, but differently" value={`${number(view.differ)} of ${number(view.both_decided)}`} />
      <Row label="Of those, right: matcher / Ollama / neither" value={`${number(view.differ_matcher_right)} / ${number(view.differ_current_right)} / ${number(view.differ_neither_right)}`} />
      {(data.disagreements || []).length > 0 && (
        <ul className="mt-1 space-y-0.5 text-footnote text-text-secondary">
          {data.disagreements.map((item, position) => (
            <li key={position}>Matcher: {item.matcher} · Ollama: {item.ollama} · confirmed: {item.confirmed} (right: {RIGHT_LABEL[item.right] || item.right})</li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function PictureFirstView({ data }) {
  const counts = data.counts
  return (
    <div className="space-y-1 border-t border-separator px-4 py-3" data-testid="scanner-lab-picture-first">
      <div>
        <h3 className="text-subheadline font-semibold">Picture match first</h3>
        <p className="text-footnote text-text-secondary">
          {data.enabled ? 'On.' : 'Off.'} Last {counts.days} days, from the scans themselves.
        </p>
      </div>
      <Row testId="scanner-lab-pf-decided" label="Decided by picture" value={number(counts.decided)} />
      <Row testId="scanner-lab-pf-ollama" label="Sent to Ollama" value={number(counts.ollama)} />
      <Row testId="scanner-lab-pf-inbox" label="Sent to the inbox while the scanner was unreachable" value={number(counts.inbox)} />
      <Row
        testId="scanner-lab-pf-different"
        label="Trainer picked a different card than the picture decided"
        value={`${number(counts.picked_different)} of ${number(counts.decided_confirmed)} confirmed${counts.error_pct != null ? ` (${counts.error_pct}%)` : ''}`}
      />
    </div>
  )
}

const CONFIRMED_LABELS = [
  ['scanner_decision', 'The scanner’s own pick, accepted'],
  ['matcher_candidate', 'Picked from the matcher’s candidates'],
  ['ollama_candidate', 'Picked from Ollama’s candidates'],
  ['manual_search', 'Found by search (no scanner offered it)'],
  ['manual_no_result', 'Found by search (scan had no result)'],
]

/** How the trainers’ confirmed cards were chosen; the two search rows are misses for every path. */
export function HowConfirmedView({ data }) {
  if (!data || !data.total) return null
  return (
    <div className="space-y-1 border-t border-separator px-4 py-3" data-testid="scanner-lab-how-confirmed">
      <h4 className="text-footnote font-semibold">How the {number(data.total)} confirmed cards were chosen</h4>
      {CONFIRMED_LABELS.map(([key, label]) => (
        <Row key={key} testId={`scanner-lab-how-${key}`} label={label} value={number(data.counts?.[key])} />
      ))}
      <p className="text-footnote text-text-secondary">
        {number(data.manual)} ({percent(data.manual_pct)}) needed the search box. Those count as misses for the matcher and for Ollama, and the cards are kept as answers for the benchmarks.
      </p>
    </div>
  )
}

export function ShadowView({ data }) {
  const report = data.report
  const confirmed = report.confirmed
  const skipped = Object.entries({ ...(report.skipped || {}), ...(data.worker?.skipped || {}) })
  return (
    <div className="space-y-2 border-t border-separator px-4 py-3" data-testid="scanner-lab-shadow">
      <div>
        <h3 className="text-subheadline font-semibold">Shadow run</h3>
        <p className="text-footnote text-text-secondary">
          The matcher looks at each new scan from trainers who share diagnostics and records what it would have decided. Nothing changes for trainers.
          {data.enabled ? '' : ' It is switched off on this server.'}
        </p>
      </div>
      <Row testId="scanner-lab-shadow-compared" label="Scans compared" value={number(report.compared)} />
      <Row label="Agree when both decided" value={`${percent(report.agreement.agree_pct)} (${number(report.agreement.same)} of ${number(report.agreement.both_decided)})`} />
      <Row label="Matcher would decide on its own" value={percent(report.matcher_decided_pct)} />
      <Row label="Median matcher time" value={report.median_ms != null ? `${number(report.median_ms)} ms` : '–'} />
      <div data-testid="scanner-lab-shadow-confirmed">
        <h4 className="text-footnote font-semibold">On the {number(confirmed.n)} scans you confirmed (English cards)</h4>
        <Row label="Matcher decided / of those, right" value={`${percent(confirmed.matcher.decided_pct)} / ${percent(confirmed.matcher.right_pct)}`} />
        <Row label="Ollama decided / of those, right" value={`${percent(confirmed.current.decided_pct)} / ${percent(confirmed.current.right_pct)}`} />
        <Row label="Different answers: matcher / Ollama / neither right" value={`${number(confirmed.differ_matcher_right)} / ${number(confirmed.differ_current_right)} / ${number(confirmed.differ_neither_right)}`} />
      </div>
      {skipped.length > 0 && (
        <p className="text-footnote text-text-secondary">Skipped: {skipped.map(([reason, count]) => `${reason.replace(/_/g, ' ')} (${count})`).join(', ')}</p>
      )}
      {report.disagreements.length > 0 && (
        <div data-testid="scanner-lab-shadow-disagreements">
          <h4 className="text-footnote font-semibold">Latest disagreements</h4>
          <ul className="space-y-0.5 text-footnote text-text-secondary">
            {report.disagreements.map((item, position) => (
              <li key={position}>
                Matcher: {item.matcher} · Ollama: {item.current}{item.confirmed ? ` · confirmed: ${item.confirmed} (right: ${RIGHT_LABEL[item.right] || item.right})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * Settings › Data & sync, admins only: the picture matcher prototype (docs/CARD_MATCH.md). Index
 * coverage, build and benchmark buttons, and the latest benchmark report against the Phase 1 pass bar.
 * Nothing here changes how scans are recognised or what trainers see.
 */
export default function ScannerLabSection() {
  const queryClient = useQueryClient()
  const { data, isError } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.get('/card-match/status').then(response => response.data),
    refetchInterval: query => (query.state.data?.job?.running ? 3000 : false),
    retry: false,
  })
  const shadow = useQuery({
    queryKey: SHADOW_KEY,
    queryFn: () => api.get('/card-match/shadow').then(response => response.data),
    refetchInterval: 30000,
    retry: false,
  })
  const pictureFirst = useQuery({
    queryKey: ['card-match-picture-first'],
    queryFn: () => api.get('/card-match/picture-first').then(response => response.data),
    refetchInterval: 60000,
    retry: false,
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY })
  const buildIndex = useMutation({ mutationFn: () => api.post('/card-match/index').then(r => r.data), onSuccess: refresh })
  const benchmark = useMutation({ mutationFn: kind => api.post('/card-match/benchmark', { kind }).then(r => r.data), onSuccess: refresh })
  const buildExtra = useMutation({ mutationFn: name => api.post('/card-match/index', { name }).then(r => r.data), onSuccess: refresh })
  const stop = useMutation({ mutationFn: () => api.post('/card-match/stop').then(r => r.data), onSuccess: refresh })

  if (isError || !data) return null
  const job = data.job || {}
  const index = data.index || {}
  const running = Boolean(job.running)
  const ready = data.model?.available
  const progress = job.progress || {}
  const errorText = buildIndex.error?.response?.data?.detail || benchmark.error?.response?.data?.detail || buildExtra.error?.response?.data?.detail
  const busy = running || buildIndex.isPending || benchmark.isPending || buildExtra.isPending
  const extras = Object.entries(data.extra_indexes || {})

  let jobLine = null
  if (running) {
    const done = progress.indexed ?? progress.done
    const total = progress.todo ? progress.total : progress.total
    jobLine = `Running: ${job.kind}${done != null && total ? ` · ${number(done)} of ${number(total)}` : ''}`
  } else if (job.error) {
    jobLine = `Last job failed: ${job.error}`
  }

  return (
    <section className="space-y-1" data-testid="scanner-lab">
      <h2 className="px-4 pb-1.5 text-footnote text-text-secondary">Scanner lab</h2>
      <div className="overflow-hidden rounded-xl bg-card">
        <div className="space-y-2 px-4 py-3">
          <p className="text-footnote text-text-secondary">
            The picture matcher prototype. It only changes how scans are recognised while "Picture match first" is on in Settings › Scanner.
          </p>
          <Row testId="scanner-lab-coverage" label="English cards indexed" value={`${number(index.count)} of ${number(data.english_total)}`} />
          <Row label="Model" value={`${data.model?.name}${ready ? '' : ' (missing from this image)'}`} />
          <Row label="Index built" value={index.built ? `${index.built_at?.slice(0, 16).replace('T', ' ')} UTC · ${duration(index.build_seconds) || 'in steps'}` : 'not yet'} />
          <Row label="Threads" value={`${data.threads}${data.autorun ? ' · runs by itself after a deploy' : ''}`} />
          <Row testId="scanner-lab-options" label="Matching options in use" value={describeOptions(data.options?.active || 'baseline')} />
          {extras.map(([name, extra]) => (
            <Row key={name} label={`Index: ${extra.label}`} value={extra.built ? `${number(extra.count)} pictures` : 'not built'} />
          ))}
          {!data.ocr_available && <p className="text-footnote text-red-500">The OCR library is not installed in this image.</p>}
          {jobLine && <p className="text-footnote" aria-live="polite" data-testid="scanner-lab-job">{jobLine}</p>}
          {errorText && <p className="text-footnote text-red-500">{errorText}</p>}
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" className={button} disabled={busy || !ready} onClick={() => buildIndex.mutate()} data-testid="scanner-lab-build">
              <Hammer size={13} aria-hidden="true" /> {index.built ? 'Update index' : 'Build index'}
            </button>
            <button type="button" className={button} disabled={busy || !ready || !index.built} onClick={() => benchmark.mutate('synthetic')} data-testid="scanner-lab-synthetic">
              <FlaskConical size={13} aria-hidden="true" /> Run benchmark (synthetic)
            </button>
            <button type="button" className={button} disabled={busy || !ready || !index.built || !data.labelled_traces} onClick={() => benchmark.mutate('labelled')} data-testid="scanner-lab-labelled">
              <FlaskConical size={13} aria-hidden="true" /> Run on diagnostics ({number(data.labelled_traces)} scans)
            </button>
            <button type="button" className={button} disabled={busy || !ready || !data.labelled_traces || !data.ocr_available} onClick={() => benchmark.mutate('ocr-check')} data-testid="scanner-lab-ocr-check-run">
              <FlaskConical size={13} aria-hidden="true" /> OCR check ({number(data.labelled_traces)} scans)
            </button>
            <button type="button" className={button} disabled={busy || !ready || !index.built || !data.labelled_traces} onClick={() => benchmark.mutate('compare-labelled')} data-testid="scanner-lab-compare">
              <GitCompare size={13} aria-hidden="true" /> Compare options (real scans)
            </button>
            <button type="button" className={button} disabled={busy || !ready || !index.built} onClick={() => benchmark.mutate('compare-synthetic')} data-testid="scanner-lab-compare-synthetic">
              <GitCompare size={13} aria-hidden="true" /> Compare options (synthetic)
            </button>
            {extras.map(([name, extra]) => (
              <button key={name} type="button" className={button} disabled={busy || !extra.available || !index.built} onClick={() => buildExtra.mutate(name)} data-testid={`scanner-lab-build-${name}`}>
                <Hammer size={13} aria-hidden="true" /> {extra.built ? 'Update' : 'Build'} {extra.label} index
              </button>
            ))}
            {running && (
              <button type="button" className={button} onClick={() => stop.mutate()}>Stop</button>
            )}
          </div>
        </div>
        {pictureFirst.data?.counts && <PictureFirstView data={pictureFirst.data} />}
        {shadow.data?.report && (shadow.data.enabled || shadow.data.report.compared > 0) && <ShadowView data={shadow.data} />}
        <HowConfirmedView data={shadow.data?.report?.how_confirmed} />
        {data.reports?.synthetic && <Report report={data.reports.synthetic} title="Latest benchmark: synthetic photos" />}
        {data.reports?.labelled && <Report report={data.reports.labelled} title="Latest benchmark: real scans (diagnostics)" />}
        {data.reports?.['ocr-check'] && <OcrCheckView report={data.reports['ocr-check']} />}
        {data.reports?.['compare-labelled'] && <CompareTable report={data.reports['compare-labelled']} title="Option comparison: real scans" />}
        {data.reports?.['compare-synthetic'] && <CompareTable report={data.reports['compare-synthetic']} title="Option comparison: synthetic photos" />}
        {data.misses && <Misses version={data.misses.created_at} />}
        {!data.reports?.synthetic && !data.reports?.labelled && (
          <p className="border-t border-separator px-4 py-3 text-footnote text-text-secondary">No benchmark has run yet.</p>
        )}
      </div>
    </section>
  )
}
