import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CompareTable, HowConfirmedView, OcrCheckView, PictureFirstView, Report, ShadowView } from './ScannerLabSection'
import { MissesView, StripRow } from './ScannerLabMisses'

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
    expect(html).toContain('the 120 photos where it ran')
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

  it('shows the typical camera frame and the card height read, new scans against older ones', () => {
    const camera = { verdict: 'sharp', new_scans: 12, older_scans: 30, frame_long_side: 3840, frame_common: [3840, 2160], crop_long_side: 1600, card_height_new: 1408, card_height_older: 880 }
    const html = renderToStaticMarkup(<ShadowView data={{ ...data, report: { ...data.report, camera } }} />)
    expect(html).toContain('Camera and reading detail')
    expect(html).toContain('3,840 × 2,160')
    expect(html).toContain('1,408 px')
    expect(html).toContain('older scans (30)')
    expect(html).toContain('880 px')
    expect(html).toContain('keeps real detail')
  })

  it('says plainly when the phone only sends 1080p frames, so the sharper crop cannot help', () => {
    const camera = { verdict: 'hd', new_scans: 9, older_scans: 30, frame_long_side: 1920, frame_common: [1920, 1080], crop_long_side: 1400, card_height_new: 867, card_height_older: 880 }
    const html = renderToStaticMarkup(<ShadowView data={{ ...data, report: { ...data.report, camera } }} />)
    expect(html).toContain('about 1080p')
    expect(html).toContain('cannot add detail')
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

  it('makes each picture tappable (full size opens in a viewer) and says what the rotation measurement found', () => {
    const withRotation = { ...data, items: [{ ...data.items[0], rotation: { upright: 0.62, turned: 0.31, margin: -0.31, rotated: false }, orientation: { by: 'default' }, text_input: { source: 'full_photo', width: 1008, height: 1408 } }] }
    const html = renderToStaticMarkup(<MissesView data={withRotation} tag={null} onTag={() => {}} onMore={() => {}} />)
    expect(html).toContain('data-testid="miss-open"')
    expect(html).toContain('Open Flat card the matcher used at full size')
    expect(html).toContain('Measured against the confirmed card: upright')
    expect(html).toContain('upright by default')
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

describe('Scanner lab OCR views', () => {
  it('shows what each region read, with text and confidence, and says when nothing was read', () => {
    const read = { label: 'number-left-tight', variant: 'plain', zoom: 2, flipped: false, image: 'data:image/jpeg;base64,AA', lines: [{ text: 'SVI EN 018/091', score: 0.93 }] }
    const empty = { label: 'bottom-band', variant: 'clahe', zoom: 2.5, flipped: true, image: null, lines: [] }
    const html = renderToStaticMarkup(<ul><StripRow strip={read} /><StripRow strip={empty} /></ul>)
    expect(html).toContain('number left tight')
    expect(html).toContain('93%')
    expect(html).toContain('SVI EN 018/091')
    expect(html).toContain('Nothing read.')
    expect(html).toContain('card turned')
    expect(html).toContain('local contrast')
  })

  it('splits the OCR check by stored resolution, old way against new, and lists the failures', () => {
    const row = (name, number) => ({ n: 40, name_pct: name, number_pct: number, total_pct: 70, set_code_pct: 50, seconds_p95: 0.9 })
    const html = renderToStaticMarkup(
      <OcrCheckView
        report={{
          traces: 139, skipped: 2, created_at: '2026-11-05T01:00:00+00:00', duration_seconds: 300,
          by_resolution: {
            1024: { fixed: row(40, 30), detect: row(80, 70), 'variant:clahe': row(60, 50) },
            full: { fixed: row(45, 35), detect: row(85, 75) },
          },
          failures: [{ trace: 't.json', resolution: '1024', height: 880, truth: { name: 'Lapras', number: '017', total: '128' }, read: { name: null, number: '017', total: '128' }, lines: ['30C | 017/128'] }],
        }}
      />,
    )
    expect(html).toContain('Older scans: 1024 px crop')
    expect(html).toContain('Newer scans: full resolution')
    expect(html).toContain('Fixed strips (old way)')
    expect(html).toContain('Find and read (new way)')
    expect(html).toContain('Band: local contrast')
    expect(html).toContain('900 ms')
    expect(html).toContain('Lapras #017/128')
    expect(html).toContain('30C | 017/128')
  })
})

describe('Scanner lab matcher version 6 views', () => {
  const group = { n: 120, top1: 70, top20: 96.7, decided: 68.3, decided_right: 100, decided_wrong: 0 }

  it('splits the real-photo report by scan time and says plainly when there are no new scans', () => {
    const base = { ...report, kind: 'labelled' }
    const both = renderToStaticMarkup(<Report report={{ ...base, by_scan_time: { tuning: group, new: { ...group, n: 30 } } }} title="Real scans" />)
    expect(both).toContain('Used for tuning')
    expect(both).toContain('New scans, not used for tuning')
    expect(both).not.toContain('No new scans yet')
    const none = renderToStaticMarkup(<Report report={{ ...base, by_scan_time: { tuning: group, new: null } }} title="Real scans" />)
    expect(none).toContain('No new scans yet')
  })

  it('counts the right first picks that were not decided, by reason, and says how many scans Ollama ran on', () => {
    const undecided = { all: { scans: 30, first_right: 30, undecided: 10, reasons: [{ reason: 'rules_choice_not_close_in_picture', n: 7 }, { reason: 'odd_new_reason', n: 3 }] } }
    const html = renderToStaticMarkup(
      <Report
        report={{ ...report, kind: 'labelled', undecided_first_right: undecided, ollama_today: { n: 120, not_run: 20, decided_pct: 15, decided_right_pct: 88, in_candidates_pct: 80, top1_pct: 63 } }}
        title="Real scans"
      />,
    )
    expect(html).toContain('10 of 30 scans with the right first pick')
    expect(html).toContain('its picture is not close enough')
    expect(html).toContain('odd new reason')
    expect(html).toContain('on the 120 photos where it ran')
    expect(html).toContain('20 more were decided by the picture first')
  })

  it('shows the scans where the card was not found, and what each reading step rescues', () => {
    const fallback = { scans: 10, by_kind: { full_photo: null, guide_crop: { ...group, n: 10, decided: 0, decided_right: null } }, found_on_photo: group }
    const html = renderToStaticMarkup(<Report report={{ ...report, kind: 'labelled', fallback }} title="Real scans" />)
    expect(html).toContain('not found (10 scans)')
    expect(html).toContain('Read from the guide frame')
    const steps = {
      all: {
        scans: 100, never_number: 12, never_name: 5,
        number: [{ step: 'bottom-band / binary', label: 'bottom-band', variant: 'binary', run: 20, first_right: 3, mean_ms: 310, total_seconds: 6.2 }],
        name: [{ step: 'name-line / plain', label: 'name-line', variant: 'plain', run: 100, first_right: 90, mean_ms: 120, total_seconds: 12 }],
      },
    }
    const check = renderToStaticMarkup(<OcrCheckView report={{ traces: 100, skipped: 0, by_resolution: {}, steps }} />)
    expect(check).toContain('What each reading step rescues')
    expect(check).toContain('Number: whole bottom band · black and white')
    expect(check).toContain('Never right')
    expect(check).toContain('310 ms')
  })

  it('names the faster reading option', () => {
    const html = renderToStaticMarkup(
      <CompareTable report={{ kind: 'compare-labelled', n: 139, created_at: '2026-11-06T01:00:00+00:00', duration_seconds: 100, winner: null, rows: [{ label: 'names+art+fastread', status: 'skipped', missing_indexes: ['x'] }] }} title="Compare" />,
    )
    expect(html).toContain('faster reading')
  })
})

describe('Scanner lab version 7', () => {
  const never = {
    full: {
      scans: 105, sets: [{ set: 'PBL', scans: 20, wrong: 15 }],
      buckets: [
        { key: 'no_text', label: 'No text read anywhere in the bottom area', n: 1, examples: [{ trace: 't1', name: 'Mon', set: 'PBL', truth: { number: '018', total: '091' }, read: { number: null, total: null }, lines: [] }] },
        { key: 'no_number_shape', label: 'Text read, but nothing shaped like a number', n: 2, examples: [{ trace: 't2', name: 'Mew', set: 'CRI', truth: { number: '007', total: '100' }, read: { number: null, total: null }, lines: ['SVI EN', 'Illus. A'] }] },
        { key: 'wrong_number', label: 'A number read that is not the confirmed card’s', n: 0, examples: [] },
        { key: 'total_differs', label: 'The right number, but a different total than the catalogue prints', n: 0, examples: [] },
      ],
    },
  }

  it('shows why the number was never right', () => {
    const html = renderToStaticMarkup(
      <OcrCheckView report={{ traces: 105, skipped: 0, by_resolution: { full: { 'source:sharp': { n: 105, name_pct: 90.5, number_pct: 59, total_pct: 52.4, set_code_pct: 6.7 }, 'source:shrunk': { n: 105, name_pct: 88, number_pct: 70, total_pct: 65, set_code_pct: 8 } } }, never_right: never }} />,
    )
    expect(html).toContain('Text read, but nothing shaped like a number: <span class="tabular-nums">2</span>')
    expect(html).toContain('confirmed 007/100 · read no number · text: SVI EN | Illus. A')
    expect(html).toContain('PBL 15 of 20')
  })

  it('opens the decided-wrong list from the picture-first figure and puts that filter first in Misses', () => {
    const picture = { enabled: true, counts: { days: 30, decided: 10, ollama: 2, inbox: 0, picked_different: 1, decided_confirmed: 9, error_pct: 11.1 } }
    const html = renderToStaticMarkup(<PictureFirstView data={picture} onOpenDecidedWrong={() => {}} />)
    expect(html).toContain('scanner-lab-pf-different-open')
    expect(renderToStaticMarkup(<PictureFirstView data={picture} />)).not.toContain('scanner-lab-pf-different-open')
    const wrong = {
      key: 'w', kind: 'decided_wrong', rank: 1, tags: ['decided_wrong', 'holo'], decided_wrong: true, mechanism: 'number_and_picture',
      truth: { name: 'Mon', number: '7', printed_total: 91, set: 'Set A', similarity: 0.9, tcg_card_id: 'a-7' },
      decided_card: { tcg_card_id: 'b-7', name: 'Mon', number: '7', printed_total: 91, set: 'Set B', similarity: 0.83, rank: 2, lead: 0.07 },
      top3: [], ocr: { name: 'Mon', number: '7', total: '91', lines: [] }, photo: null, card: null,
    }
    const view = renderToStaticMarkup(
      <MissesView
        data={{ available: true, created_at: '2026-11-10T01:00:00+00:00', scans: 276, misses: 16, decided_wrong: 1, options: 'x', total: 1, offset: 0, tags: { decided_wrong: 'Decided wrong', holo: 'Holo' }, counts: { decided_wrong: 1, holo: 1 }, items: [wrong] }}
        tag="decided_wrong" onTag={() => {}} onMore={() => {}}
      />,
    )
    expect(view.indexOf('Decided wrong (1)')).toBeLessThan(view.indexOf('All (16)'))
    expect(view).toContain('the number fit several printings and the picture picked one')
    expect(view).toContain('Decided: Mon · Set B · #7/91 · picture 0.83 · ranked 2')
    expect(view).toContain('Confirmed: Mon · Set A · #7/91 · picture 0.9 · ranked 1')
    expect(view).toContain('Read: number 7/91')
  })

  it('shows the zero count of decided wrong scans and the new fallback row', () => {
    const view = renderToStaticMarkup(
      <MissesView data={{ available: true, created_at: '2026-11-10T01:00:00+00:00', scans: 5, misses: 0, decided_wrong: 0, total: 0, offset: 0, tags: { decided_wrong: 'Decided wrong' }, counts: {}, items: [] }} tag={null} onTag={() => {}} onMore={() => {}} />,
    )
    expect(view).toContain('Decided wrong (0)')
    const fallback = { scans: 4, by_kind: { review_photo: { n: 2, top1: 100, top20: 100, decided: 50, decided_right: 100 }, full_photo: null, guide_crop: { n: 2, top1: 50, top20: 100, decided: 0, decided_right: null } }, found_on_photo: null }
    expect(renderToStaticMarkup(<Report report={{ ...report, kind: 'labelled', fallback }} title="Real scans" />)).toContain('Found on the whole review photo')
  })

  it('names the finder options', () => {
    const html = renderToStaticMarkup(
      <CompareTable report={{ kind: 'compare-labelled', n: 139, created_at: '2026-11-06T01:00:00+00:00', duration_seconds: 100, winner: null, rows: [{ label: 'names+fastread+corners+wholepic', status: 'skipped', missing_indexes: ['x'] }] }} title="Compare" />,
    )
    expect(html).toContain('self-doubting card finder')
    expect(html).toContain('whole picture when corners are refused')
  })

  it('shows the corners check in plain words, and the measurements on a Corners off miss', () => {
    const group = { scans: 276, no_quad: 15, spoiled: 40, whole_better: 22, spoiled_no_number: 25, no_number_all: 90, refused_now: 38, refused_among_spoiled: 35, coverage: { min: 0.2, median: 0.4, max: 0.5 }, ratio_error: { min: 0, median: 0.02, max: 0.1 }, angle_deviation: { min: 0, median: 3, max: 20 }, coverage_of_the_rest: { min: 0.5, median: 0.8, max: 0.95 }, mean_gain: 0.12 }
    const corners = { margin: 0.05, all: group, tuning: { ...group, scans: 139, spoiled: 10 }, new: { ...group, scans: 137, spoiled: 30 }, sets: [{ set: 'Black Bolt', scans: 64, spoiled: 20, spoiled_no_number: 15 }], refused_reasons: { too_small: 30, sideways: 8 } }
    const html = renderToStaticMarkup(<Report report={{ ...report, kind: 'labelled', corners_check: corners }} title="Real scans" />)
    expect(html).toContain('Did the card finder spoil the scan? (276 scans)')
    expect(html).toContain('the guide frame was closer by at least 0.05')
    expect(html).toContain('Black Bolt 20 of 64')
    expect(html).toContain('30 too small a part of the picture')
    expect(renderToStaticMarkup(<Report report={{ ...report, kind: 'labelled', corners_check: null }} title="Real scans" />)).not.toContain('spoil the scan')
    const item = {
      key: 'c', kind: 'not_top1', rank: 3, tags: ['corners_off'], truth: { name: 'Slowpoke', number: '29', set: 'Pitch Black', tcg_card_id: 'x-29' }, top3: [],
      ocr: { lines: [] }, photo: null, card: null, corners: { quad: 0.41, guide: 0.77, whole: 0.8, coverage: 0.4, ratio_error: 0.01, angle_deviation: 2, refused: 'too_small' },
    }
    const view = renderToStaticMarkup(<MissesView data={{ available: true, created_at: '2026-11-10T01:00:00+00:00', scans: 5, misses: 1, total: 1, offset: 0, tags: { corners_off: 'Corners off' }, counts: { corners_off: 1 }, items: [item] }} tag={null} onTag={() => {}} onMore={() => {}} />)
    expect(view).toContain('Corners off')
    expect(view).toContain('finder’s quad 0.41, guide frame 0.77, whole picture 0.8')
    expect(view).toContain('covers 40% of the picture')
    expect(view).toContain('refuses it (too small)')
  })
})
