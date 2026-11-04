import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FlaskConical, Hammer } from 'lucide-react'
import api from '../../api/client'

const QUERY_KEY = ['card-match-status']
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
          <h4 className="text-footnote font-semibold">What today’s Ollama path got on the same {number(report.ollama_today.n)} photos</h4>
          <Row label="Decided" value={percent(report.ollama_today.decided_pct)} />
          <Row label="Of those, right" value={percent(report.ollama_today.decided_right_pct)} />
          <Row label="Right card among its candidates" value={percent(report.ollama_today.in_candidates_pct)} />
          <Row label="Right card ranked first" value={percent(report.ollama_today.top1_pct)} />
        </div>
      )}
    </div>
  )
}

/**
 * Settings › Data & sync, admins only: the picture matcher prototype (docs/CARD_MATCH.md). Index
 * coverage, build and benchmark buttons, and the latest benchmark report against the Phase 1 pass bar.
 * Nothing here changes how scans are recognised.
 */
export default function ScannerLabSection() {
  const queryClient = useQueryClient()
  const { data, isError } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api.get('/card-match/status').then(response => response.data),
    refetchInterval: query => (query.state.data?.job?.running ? 3000 : false),
    retry: false,
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY })
  const buildIndex = useMutation({ mutationFn: () => api.post('/card-match/index').then(r => r.data), onSuccess: refresh })
  const benchmark = useMutation({ mutationFn: kind => api.post('/card-match/benchmark', { kind }).then(r => r.data), onSuccess: refresh })
  const stop = useMutation({ mutationFn: () => api.post('/card-match/stop').then(r => r.data), onSuccess: refresh })

  if (isError || !data) return null
  const job = data.job || {}
  const index = data.index || {}
  const running = Boolean(job.running)
  const ready = data.model?.available
  const progress = job.progress || {}
  const errorText = buildIndex.error?.response?.data?.detail || benchmark.error?.response?.data?.detail
  const busy = running || buildIndex.isPending || benchmark.isPending

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
            The picture matcher prototype. It does not change how scans are recognised yet.
          </p>
          <Row testId="scanner-lab-coverage" label="English cards indexed" value={`${number(index.count)} of ${number(data.english_total)}`} />
          <Row label="Model" value={`${data.model?.name}${ready ? '' : ' (missing from this image)'}`} />
          <Row label="Index built" value={index.built ? `${index.built_at?.slice(0, 16).replace('T', ' ')} UTC · ${duration(index.build_seconds) || 'in steps'}` : 'not yet'} />
          <Row label="Threads" value={`${data.threads}${data.autorun ? ' · runs by itself after a deploy' : ''}`} />
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
              <FlaskConical size={13} aria-hidden="true" /> Run on diagnostics ({number(data.labelled_traces)} confirmed)
            </button>
            {running && (
              <button type="button" className={button} onClick={() => stop.mutate()}>Stop</button>
            )}
          </div>
        </div>
        {data.reports?.synthetic && <Report report={data.reports.synthetic} title="Latest benchmark: synthetic photos" />}
        {data.reports?.labelled && <Report report={data.reports.labelled} title="Latest benchmark: real scans (diagnostics)" />}
        {!data.reports?.synthetic && !data.reports?.labelled && (
          <p className="border-t border-separator px-4 py-3 text-footnote text-text-secondary">No benchmark has run yet.</p>
        )}
      </div>
    </section>
  )
}
