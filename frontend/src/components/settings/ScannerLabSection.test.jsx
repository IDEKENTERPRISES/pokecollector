import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Report } from './ScannerLabSection'

const report = {
  kind: 'synthetic',
  note: 'Synthetic photos: an upper bound.',
  created_at: '2026-11-04T04:10:00+00:00',
  duration_seconds: 912,
  host: { threads: 3, cpu_count: 6 },
  metrics: {
    n: 400, card_found_pct: 98.5, card_found_accurate_pct: 97.2, top1_pct: 93.5, top5_pct: 98, top20_pct: 99.5,
    number_exact_pct: 81.2, total_exact_pct: 84, decided_pct: 76.5, decided_right_pct: 99.3, decided_wrong: 2,
  },
  groups: { trap: { n: 50, top1: 90, top20: 99, decided: 60, decided_right: 100 } },
  timings_ms: { detect: { median: 60, p95: 90 }, total: { median: 480, p95: 900 } },
  memory: { extra_mb: 612.4, peak_rss_mb: 1100 },
  index: { count: 19800, build_seconds: 1500 },
  pass_bar: [
    { id: 'top20', label: 'Right printing in the top 20', value: 99.5, target: '>= 97%', ok: true },
    { id: 'p95', label: 'Time per photo, 95th percentile (ms)', value: 1700, target: '<= 1500 ms', ok: false },
    { id: 'ram', label: 'Extra memory (MB)', value: null, target: '<= 1536 MB', ok: null },
  ],
}

describe('Scanner lab report', () => {
  it('shows the metrics, the timings and the pass bar with passes, fails and unmeasured rows', () => {
    const html = renderToStaticMarkup(<Report report={report} title="Latest benchmark" />)
    expect(html).toContain('Latest benchmark')
    expect(html).toContain('93.5% / 98% / 99.5%')
    expect(html).toContain('Reprint traps')
    expect(html).toContain('480 ms')
    expect(html).toContain('passes')
    expect(html).toContain('fails')
    expect(html).toContain('not measured')
    expect(html).toContain('19,800 pictures')
  })

  it('shows what the Ollama path got when the report is from real scans', () => {
    const html = renderToStaticMarkup(
      <Report
        report={{ ...report, kind: 'labelled', ollama_today: { n: 120, decided_pct: 71, decided_right_pct: 88.2, in_candidates_pct: 80, top1_pct: 63 } }}
        title="Real scans"
      />,
    )
    expect(html).toContain('same 120 photos')
    expect(html).toContain('88.2%')
  })
})
