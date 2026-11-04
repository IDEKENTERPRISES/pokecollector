import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CompareTable, HowConfirmedView, PictureFirstView, Report, ShadowView } from './ScannerLabSection'
import { MissesView } from './ScannerLabMisses'

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

  it('shows matcher and Ollama side by side with who was right where they disagreed', () => {
    const view = {
      n: 40, matcher: { decided_pct: 70, right_pct: 96.4 }, current: { decided_pct: 90, right_pct: 88.9 },
      both_decided: 24, differ: 5, differ_matcher_right: 3, differ_current_right: 1, differ_neither_right: 1,
    }
    const html = renderToStaticMarkup(
      <Report
        report={{
          ...report, kind: 'labelled',
          side_by_side: { rerun: view, recorded: view, disagreements: [{ matcher: 'Pikachu', ollama: 'Raichu', confirmed: 'Pikachu', right: 'matcher' }] },
        }}
        title="Real scans"
      />,
    )
    expect(html).toContain('scanner-lab-side-by-side')
    expect(html).toContain('as recorded at scan time')
    expect(html).toContain('3 / 1 / 1')
    expect(html).toContain('Matcher: Pikachu')
    expect(html).toContain('right: the matcher')
  })
})

describe('Scanner lab shadow section', () => {
  const data = {
    enabled: true,
    worker: { skipped: { index_not_built: 2 } },
    report: {
      compared: 58, skipped: {}, matcher_decided_pct: 64.3, median_ms: 812.4,
      agreement: { same: 30, different: 4, both_decided: 34, agree_pct: 88.2 },
      confirmed: {
        n: 41, matcher: { decided_pct: 61, right_pct: 96 }, current: { decided_pct: 93.2, right_pct: 87.5 },
        differ_matcher_right: 3, differ_current_right: 1, differ_neither_right: 0,
      },
      disagreements: [{ matcher: 'Mew', current: 'Mewtwo', confirmed: 'Mew', right: 'matcher' }],
    },
  }

  it('shows the comparison counts, the matcher time and the latest disagreements by card name', () => {
    const html = renderToStaticMarkup(<ShadowView data={data} />)
    expect(html).toContain('Scans compared')
    expect(html).toContain('88.2% (30 of 34)')
    expect(html).toContain('64.3%')
    expect(html).toContain('812.4 ms')
    expect(html).toContain('On the 41 scans you confirmed')
    expect(html).toContain('61% / 96%')
    expect(html).toContain('93.2% / 87.5%')
    expect(html).toContain('3 / 1 / 0')
    expect(html).toContain('Matcher: Mew')
    expect(html).toContain('Ollama: Mewtwo')
    expect(html).toContain('index not built (2)')
  })

  it('says so when the server has shadow mode switched off', () => {
    const html = renderToStaticMarkup(<ShadowView data={{ ...data, enabled: false }} />)
    expect(html).toContain('switched off on this server')
  })
})

describe('Scanner lab option comparison', () => {
  it('lists every option set with its numbers, marks the kept one and says which index a skipped one needs', () => {
    const html = renderToStaticMarkup(
      <CompareTable
        title="Option comparison: real scans"
        report={{
          kind: 'compare-labelled', n: 132, created_at: '2026-11-05T02:00:00+00:00', duration_seconds: 1500, winner: 'names+art',
          rows: [
            { label: 'baseline', status: 'ok', top1: 46.2, top20: 72, number_exact: 37.9, decided: 40.9, decided_wrong: 0, p95_ms: 540 },
            { label: 'names+art', status: 'ok', top1: 70, top20: 97.7, number_exact: 38, decided: 55, decided_wrong: 0, p95_ms: 900 },
            { label: 'names+base', status: 'skipped', missing_indexes: ['dinov2-base'] },
          ],
        }}
      />,
    )
    expect(html).toContain('Picture only')
    expect(html).toContain('97.7%')
    expect(html).toContain('kept: Name search + artwork')
    expect(html).toContain('needs the dinov2-base index')
  })
})

describe('Scanner lab misses view', () => {
  const data = {
    available: true, created_at: '2026-11-05T02:10:00+00:00', scans: 132, misses: 2, options: 'names', total: 2, offset: 0,
    tags: { generic: 'Generic card (Basic Energy, common Trainer)', glare: 'Sleeve or top-loader glare', other: 'No clear cause' },
    counts: { generic: 1, glare: 1 },
    items: [
      {
        key: 'a', kind: 'not_in_top20', rank: null, tags: ['generic', 'glare'], decided_wrong: false,
        truth: { name: 'Grass Energy', number: '1', set: 'Base', image: 'https://img/x.png', tcg_card_id: 'base1-1' },
        top3: [{ tcg_card_id: 'sv1-257', name: 'Grass Energy', number: '257', similarity: 0.71, image: 'https://img/y.png' }],
        ocr: { name: 'Grass Energy', number: null, total: null, lines: ['HP 70'] }, photo: 'data:image/jpeg;base64,AA==', card: 'data:image/jpeg;base64,AA==',
      },
    ],
  }

  it('shows the count per cause, the pictures, the top picks and what OCR read', () => {
    const html = renderToStaticMarkup(<MissesView data={data} tag={null} onTag={() => {}} onMore={() => {}} />)
    expect(html).toContain('2 of 132 confirmed real scans')
    expect(html).toContain('Generic card (Basic Energy, common Trainer) (1)')
    expect(html).toContain('Sleeve or top-loader glare (1)')
    expect(html).not.toContain('No clear cause (')
    expect(html).toContain('not in the top 20')
    expect(html).toContain('Matcher pick 1: Grass Energy')
    expect(html).toContain('Read: name “Grass Energy”')
  })
})

describe('Picture match first counts', () => {
  const counts = { days: 7, decided: 31, ollama: 12, inbox: 4, decided_confirmed: 20, picked_different: 1, error_pct: 5 }

  it('shows the four counts for the last 7 days and the real-world error rate', () => {
    const html = renderToStaticMarkup(<PictureFirstView data={{ enabled: true, counts }} />)
    expect(html).toContain('Last 7 days')
    expect(html).toMatch(/Decided by picture<\/span><span[^>]*>31/)
    expect(html).toMatch(/Sent to Ollama<\/span><span[^>]*>12/)
    expect(html).toMatch(/while the scanner was unreachable<\/span><span[^>]*>4/)
    expect(html).toContain('1 of 20 confirmed (5%)')
  })

  it('says when it is off and copes with nothing confirmed yet', () => {
    const html = renderToStaticMarkup(<PictureFirstView data={{ enabled: false, counts: { ...counts, decided_confirmed: 0, picked_different: 0, error_pct: null } }} />)
    expect(html).toContain('Off.')
    expect(html).toContain('0 of 0 confirmed')
  })
})

describe('How confirmed cards were chosen', () => {
  it('lists every way a card was confirmed and how many needed the search box', () => {
    const data = {
      total: 10,
      manual: 3,
      manual_pct: 30,
      counts: { scanner_decision: 4, matcher_candidate: 1, ollama_candidate: 2, manual_search: 2, manual_no_result: 1 },
    }
    const html = renderToStaticMarkup(<HowConfirmedView data={data} />)
    expect(html).toContain('How the 10 confirmed cards were chosen')
    expect(html).toContain('Found by search (no scanner offered it)')
    expect(html).toContain('Found by search (scan had no result)')
    expect(html).toContain('3 (30%) needed the search box')
    expect(renderToStaticMarkup(<HowConfirmedView data={{ total: 0, counts: {} }} />)).toBe('')
  })
})
