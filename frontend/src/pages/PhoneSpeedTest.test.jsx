import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = { user: { role: 'admin' } }
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }))
vi.mock('../navigation/useNavBar', () => ({ useNavBar: () => {} }))
vi.mock('../api/client', () => ({ default: { get: vi.fn(() => new Promise(() => {})), post: vi.fn() } }))

const { default: PhoneSpeedTest, ResultsTable, MatcherResults, OcrStats, GpuDiagnosis } = await import('./PhoneSpeedTest')
const { PhoneSpeedRuns, matcherAgreementText, matcherTimingText, matcherReadLines, gpuDiagText } = await import('../components/settings/ScannerLabSection')

const render = element => renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>)

describe('Phone speed test visibility', () => {
  beforeEach(() => { auth.user = { role: 'admin' } })

  it('shows the page to an admin, with a camera input, the upload notice and the remove button', () => {
    const html = render(<PhoneSpeedTest />)
    expect(html).toContain('Phone speed test')
    expect(html).toContain('capture="environment"')
    expect(html).toContain('The photo is kept on the server with the timings (admins only)')
    expect(html).toContain('built-in sample is never uploaded')
    expect(html).toContain('Remove test files')
    expect(html).toContain('cannot be read on iOS')
  })

  it('has no switch for the 8-bit model on WebGPU, with or without WebGPU (it crashes Safari on iOS 26.6)', () => {
    vi.stubGlobal('navigator', { gpu: {}, userAgent: '' })
    const withGpu = render(<PhoneSpeedTest />)
    vi.unstubAllGlobals()
    expect(withGpu).not.toContain('8-bit model on WebGPU')
    expect(withGpu).not.toMatch(/uint8 on WebGPU|8-bit on WebGPU/) // the only checkboxes are the matcher's restart and overlap options
  })

  it('shows nothing to a trainer (it sends them back to Settings)', () => {
    auth.user = { role: 'trainer' }
    const html = render(<PhoneSpeedTest />)
    expect(html).not.toContain('Phone speed test')
    expect(html).not.toContain('phone-speed-page')
  })

  it('lists the last runs in Scanner lab with the link to the page', () => {
    const html = render(<PhoneSpeedRuns runs={[{
      id: '20261113T091500000000-abcd1234', has_photo: true, server: { status: 'done' },
      compare: { in_use: { wasm: { top1_agree: true, phone_top1_in_server_top20: true, overlap: 14 } }, phone_way: { orientation_agree: true, backends: { wasm: { whole: { top1_agree: true, overlap: 19 }, art: { top1_agree: false, overlap: 12 } } } } },
      at: '2026-11-13T09:15:00+00:00', by: 'oak', device: { ios: '26.6', ios_raw: '18.7', gpu: true, crashedBefore: true },
      timings: { embed_wasm_median_ms: 410, card_wasm_median_ms: 2900, estimate_card_wasm_ms: 3800, estimate_card_webgpu_fp16_ms: 900 },
    }]} />)
    expect(html).toContain('href="/settings/phone-speed"')
    expect(html).toContain('2026-11-13 09:15')
    expect(html).toContain('2,900 ms')
    expect(html).toContain('GPU 900 ms')
    expect(html).toContain('crashed before')
    expect(html).toContain('iOS 26.6 (user agent says 18.7)')
    expect(html).toContain('in-use set: top 1 agrees')
    expect(html).toContain('14/20 shared')
    expect(html).toContain('like-for-like (wasm): whole 19/20 shared, top 1 agrees · art 12/20 shared')
    expect(html).not.toContain('PHOTO TURNED DIFFERENTLY')
    expect(render(<PhoneSpeedRuns runs={[]} />)).toContain('No runs yet')
    expect(html).not.toContain('scanner-lab-phone-speed-delete')
    const withDelete = render(<PhoneSpeedRuns runs={[{ id: 'x', at: '2026-11-13T09:15:00', by: 'oak', has_photo: false, timings: {}, device: {} }]} onDelete={() => {}} />)
    expect(withDelete).toContain('scanner-lab-phone-speed-delete')
    expect(withDelete).toContain('no photo (built-in sample)')
  })

  it('lists a crashed run with the step it died in', () => {
    const html = render(<PhoneSpeedRuns runs={[{ id: 'x', at: '2026-11-13T09:15:00', by: 'oak', has_photo: false, crashed_step: 'card_webgpu_uint8', timings: {}, device: { ios: '26.6', ios_raw: '18.7', crashedBefore: true } }]} />)
    expect(html).toContain('Crashed during card_webgpu_uint8')
    expect(html).not.toContain('crashed before')
  })

  it('shows first run and median per step, and an error where a step failed', () => {
    const html = render(<ResultsTable steps={[['a', 'Step A'], ['b', 'Step B'], ['c', 'Step C']]} rows={{ a: { first: 1200, median: 800 }, b: { error: 'unsupported operator ConvInteger' } }} />)
    expect(html).toContain('1,200 ms')
    expect(html).toContain('800 ms')
    expect(html).toContain('unsupported operator ConvInteger')
  })
})

describe('the full phone matcher section (step 3d)', () => {
  beforeEach(() => { auth.user = { role: 'admin' } })

  it('explains the run, the photo handling and the backend choice, and has the run and release buttons', () => {
    const html = render(<PhoneSpeedTest />)
    expect(html).toContain('Full phone matcher')
    expect(html).toContain('three times on one photo')
    expect(html).toContain('2048 px long side, JPEG')
    expect(html).toContain('data-testid="phone-matcher-run"')
    expect(html).toContain('data-testid="phone-matcher-release"')
    expect(html).toContain('uint8 on WebAssembly in the worker (safe default)')
    expect(html).toContain('uint8 on WebAssembly on the main thread')
    expect(html).toContain('data-testid="phone-gpu-diag-worker"')
    expect(html).toContain('data-testid="phone-gpu-diag-main"')
    expect(html).toMatch(/<option value="wasm" selected/) // the safe backend is the default
    expect(html).not.toContain('uint8 on WebGPU') // never offered
    expect(html).toContain('data-testid="phone-matcher-carddb"')
  })

  const result = over => ({
    version: 11, backend: 'fp16 on WebGPU (worker)', decided: true, tcgCardId: 'sv1-25', cardId: 'sv1-25_en', mechanism: 'number_unique', unsure_reason: null,
    decision: { similarity: 0.93 }, pictureOnly: false, notes: [],
    read: { number: '25', total: '198', name: 'Pikachu', numberSource: 'finder_card' }, orientation: { by: 'default', flipped: false }, detection: { found: true, source: 'quad' },
    candidates: [1, 2, 3, 4, 5, 6].map(n => ({ id: `sv${n}-25_en`, tcgCardId: `sv${n}-25`, name: `Pikachu${n}`, number: '25', set: `Set ${n}`, score: 1 - n / 10 })),
    timings_ms: { finder: 600, views: 300, embed: 800, search: 90, ocr_number: 500, name: 200, second_read: 0, decide: 20, total: 2510 },
    ...over,
  })

  it('shows the stage times (first and median of the next two), the backend, the decision and the top 5 with names', () => {
    const html = render(<MatcherResults results={[result(), result({ timings_ms: { ...result().timings_ms, total: 2000 } }), result({ timings_ms: { ...result().timings_ms, total: 2200 } })]} sent="Numbers saved." />)
    expect(html).toContain('Find the card')
    expect(html).toContain('Total of this run')
    expect(html).toContain('warm worker')
    expect(html).toContain('Median of 2')
    expect(html).toContain('2,510 ms')
    expect(html).toContain('2,100 ms')
    expect(html).toContain('fp16 on WebGPU (worker)')
    expect(html).toContain('Pikachu1 #25 · number_unique'.replace('Pikachu1', 'Pikachu1'))
    expect((html.match(/<li>/g) || []).length).toBe(5)
    expect(html).toContain('Pikachu5 #25 · Set 5')
    expect(html).not.toContain('Pikachu6')
    expect(html).toContain('Numbers saved.')
  })

  it('says plainly when the run was picture-only for want of the card database', () => {
    const html = render(<MatcherResults results={[result({ pictureOnly: true, decided: false, tcgCardId: null, mechanism: null, unsure_reason: 'no_card_database', read: null, notes: ['The card database is not on this phone: the picture alone, no decision.'] })]} />)
    expect(html).toContain('picture only (no card database)')
    expect(html).toContain('The card database is not on this phone')
  })

  it('warns when the three runs did not agree', () => {
    expect(render(<MatcherResults results={[result(), result({ tcgCardId: 'sv9-9' })]} />)).toContain('did not give the same answer')
  })

  it('Scanner lab lists the full matcher as "phone X / server Y · agree yes/no · N/20"', () => {
    const run = {
      id: 'x', at: '2026-11-13T09:15:00', by: 'oak', has_photo: true, server: { status: 'done' }, device: { ios: '26.6', gpu: true }, timings: { matcher_total_median_ms: 2100 },
      matcher: { decided: true, card: 'sv1-25', backend: 'fp16 on WebGPU (worker)', timings: { finder: [610, 590], embed: [820, 790], total: [2500, 2100] } },
      matcher_compare: { status: 'compared', phone: 'sv1-25', server: 'sv1-25', agree: true, same_card: true, same_mechanism: true, overlap: 17 },
    }
    expect(matcherAgreementText(run)).toBe('full matcher: phone sv1-25 / server sv1-25 · agree yes · 17/20')
    expect(matcherAgreementText({ ...run, matcher: { ...run.matcher, decided: false, card: null }, matcher_compare: { status: 'compared', phone: null, server: 'sv1-25', agree: false, overlap: 9 } })).toBe('full matcher: phone unsure / server sv1-25 · agree no · 9/20')
    expect(matcherAgreementText({ ...run, matcher_compare: { status: 'compared', phone: 'sv1-25', server: 'sv1-25', agree: true, same_card: true, same_mechanism: false, overlap: 20, phone_mechanism: 'number_unique', server_mechanism: 'number_and_picture' } })).toContain('mechanism differs')
    expect(matcherAgreementText({ ...run, matcher_compare: null })).toContain('server answer')
    expect(matcherAgreementText({ ...run, has_photo: false })).toContain('no photo')
    expect(matcherTimingText(run)).toBe('fp16 on WebGPU (worker) · finder 590 · embed 790 · total 2,100 ms (first 2,500)')
    const html = render(<PhoneSpeedRuns runs={[run]} />)
    expect(html).toContain('full phone matcher')
    expect(html).toContain('full matcher: phone sv1-25 / server sv1-25 · agree yes · 17/20')
  })
})

describe('the matcher options and statistics on the page (iPhone fix)', () => {
  it('offers one run only, a fresh worker per run, overlap, the reader on WebGPU and the lean ladder, with the safe choices first', () => {
    const html = render(<PhoneSpeedTest />)
    expect(html).toMatch(/data-testid="phone-matcher-low"/)
    expect(html).toContain('Low memory: one thing at a time')
    expect(html).toMatch(/checked[^>]*data-testid="phone-matcher-low"|data-testid="phone-matcher-low"[^>]*checked/)
    for (const id of ['runs', 'restart', 'overlap', 'ocr', 'ladder']) expect(html).toContain(`data-testid="phone-matcher-${id}"`)
    expect(html).toContain('1 run only')
    expect(html).toContain('WebGPU on the main thread (fp32')
    expect(html).toContain('Lean: the first 3 steps')
    expect(html).toMatch(/data-testid="phone-matcher-restart"[^>]*checked|checked[^>]*data-testid="phone-matcher-restart"/)
    expect(html).not.toMatch(/checked[^>]*data-testid="phone-matcher-overlap"|data-testid="phone-matcher-overlap"[^>]*checked/)
  })

  it('shows the reader calls per stage, the ladder and why it stopped, and the memory estimate', () => {
    const stats = {
      calls: { ocr_number: { det: { n: 3, ms: 420, perCall: 140, inputs: ['1x3x128x704', '1x3x128x704'] }, rec: { n: 4, ms: 130, perCall: 32.5, inputs: ['1x3x48x320'] } } },
      number: { attempts: 3, steps: [{ label: 'number-left-tight', variant: 'plain', ms: 300 }], stopped: 'budget', budget: 0.9, seconds: 0.95 },
      name: { steps: [{ label: 'name-line', ms: 120, lines: 0, text: '' }] },
    }
    const html = render(<OcrStats stats={stats} />)
    expect(html).toContain('3 × 140 ms')
    expect(html).toContain('1x3x128x704')
    expect(html).toContain('4 × 32.5 ms')
    expect(html).toContain('3 of 6 steps ran')
    expect(html).toContain('stopped by the 0.9 s budget')
    expect(html).toContain('name-line 120 ms, 0 line(s)')
    expect(render(<OcrStats stats={null} />)).toBe('')
    const memory = { rows: [['Picture indexes', 60], ['Embedding model', 42]], total: 102 }
    const withMemory = render(<MatcherResults results={[{ decided: false, candidates: [], timings_ms: {}, ocrStats: stats }]} memory={memory} />)
    expect(withMemory).toContain('Picture indexes: 60 MB')
    expect(withMemory).toContain('Total about 102 MB')
  })
})

describe('the WebGPU test on the page (iPhone fix)', () => {
  it('lists each step, marks the failure in red with the real error, and shows nothing before a test', () => {
    expect(render(<GpuDiagnosis diag={null} />)).toBe('')
    const html = render(<GpuDiagnosis diag={{ where: 'worker', running: false, rows: [{ step: 'adapter', ok: true, ms: 12, note: 'apple / common-3' }, { step: 'session', ok: false, ms: 900, note: 'RangeError: out of memory' }] }} />)
    expect(html).toContain('WebGPU in the worker')
    expect(html).toContain('✓ adapter · 12 ms · apple / common-3')
    expect(html).toContain('✗ session · 900 ms · RangeError: out of memory')
    expect(html).toContain('text-red-500')
  })
})

describe('honest totals, presets and warnings on the page (round 2)', () => {
  const base = {
    version: 11, backend: 'uint8 on WebAssembly (main thread)', decided: false, mechanism: null, unsure_reason: 'rules_choice_not_close_in_picture', candidates: [], pictureOnly: false,
    timings_ms: { finder: 300, views: 150, embed: 2000, search: 45, ocr_number: 1400, name: 370, second_read: 0, catalogue: 1200, decide: 9, other: 20, total: 5500, warm: 4300, saved: 0 },
  }

  it('shows the card database index build, the in-between time and the warm per-card time as their own rows, and where the rest of the time went', () => {
    const html = render(<MatcherResults results={[{ ...base, transferMs: 60 }]} info={{ loadMs: 786 }} />)
    expect(html).toContain('Card database indexes (built once per worker)')
    expect(html).toContain('1,200 ms')
    expect(html).toContain('Between the stages')
    expect(html).toContain('Per card with a warm worker')
    expect(html).toContain('4,300 ms')
    expect(html).toContain('(786 ms)')
    expect(html).toContain('(60 ms this run)')
    expect(html).not.toContain('Saved by overlap') // nothing was saved
  })

  it('shows what overlap saved when it ran, and says why when it did not', () => {
    const saved = render(<MatcherResults results={[{ ...base, timings_ms: { ...base.timings_ms, saved: 1300, other: 0 }, overlap: { asked: true, used: true, why: null } }]} />)
    expect(saved).toContain('Saved by overlap')
    expect(saved).toContain('Overlap: used')
    const not = render(<MatcherResults results={[{ ...base, overlap: { asked: true, used: false, why: 'low memory is on (it loads things one at a time)' } }]} />)
    expect(not).toContain('Overlap: NOT used, because low memory is on')
  })

  it('warns, in red, when cards in the phone\'s database lack their printed total (the server compares them with it)', () => {
    const html = render(<MatcherResults results={[{ ...base, catalogue: { present: true, cards: 19659, printedTotalMissing: 19659 } }]} />)
    expect(html).toContain('19,659 cards in this phone')
    expect(html).toContain('Sync the card database again')
    expect(render(<MatcherResults results={[{ ...base, catalogue: { present: true, cards: 19659, printedTotalMissing: 0 } }]} />)).not.toContain('no printed set total')
  })

  it('has one-click presets for the safe, warm, fast WebGPU-in-the-worker and parallel combinations', () => {
    const html = render(<PhoneSpeedTest />)
    for (const id of ['safe', 'warm', 'gpu', 'parallel']) expect(html).toContain(`data-testid="phone-preset-${id}"`)
    expect(html).toContain('Fast: fp16 WebGPU in the worker, one warm worker')
  })
})

describe('Scanner lab: the server read beside the phone read, and the WebGPU test rows (round 2)', () => {
  const compare = {
    status: 'compared', phone: null, server: '30th-061', agree: false, overlap: 18,
    phone_read: { number: '061', total: '128', name: null, source: 'finder_card' }, server_read: { number: '061', total: '128', name: 'Morpeko', source: 'finder_card' }, name_agrees: false,
    phone_name_steps: [{ label: 'name-line', lines: 0, text: '' }, { label: 'top-wide', lines: 0, text: '' }],
    server_name_steps: [{ label: 'name-line', lines: 1, text: 'Morpeko', after: 'Morpeko' }],
    phone_number_steps: [{ label: 'number-left-tight', lines: 1, text: '061', after: '061/-' }], server_number_steps: [{ label: 'number-left-tight', lines: 1, text: '061/128', after: '061/128' }],
    phone_text_input: { source: 'photo', width: 1008, height: 1408 }, server_text_input: { source: 'photo', width: 1008, height: 1408 },
    phone_rank: 9, phone_similarity: 0.609, server_rank: 3, server_similarity: 0.65, phone_reason: 'rules_choice_not_close_in_picture', server_reason: null,
  }
  const run = { id: 'x', at: '2026-11-13T09:15:00', by: 'oak', has_photo: true, server: { status: 'done' }, device: { ios: '26.6', gpu: true }, timings: {}, matcher: { decided: false, card: null, backend: 'uint8 on WebAssembly (worker)', timings: { total: [5500, 5500], warm: [4300, 4300], catalogue: [1200, 1200] }, setup: { load_ms: 786 }, catalogue: { printed_total_missing: 100 } }, matcher_compare: compare }

  it('puts the phone read and the server read, name strips, number steps and picture rank side by side', () => {
    const lines = matcherReadLines(run)
    expect(lines[0]).toBe('reads: phone 061/128 · no name · finder_card / server 061/128 · Morpeko · finder_card · NAME DIFFERS')
    expect(lines[1]).toBe('name strips: phone name-line 0 line(s), top-wide 0 line(s) / server name-line 1 line(s) "Morpeko" → Morpeko')
    expect(lines[2]).toContain('phone number-left-tight 1 line(s) "061" → 061/-')
    expect(lines[2]).toContain('server number-left-tight 1 line(s) "061/128" → 061/128')
    expect(lines[3]).toBe('text read from: phone photo 1008x1408 / server photo 1008x1408')
    expect(lines[4]).toContain('phone 9 (similarity 0.609) / server 3 (similarity 0.65)')
    expect(lines[5]).toBe('reasons: phone rules_choice_not_close_in_picture / server decided')
    expect(matcherReadLines({ ...run, matcher_compare: { status: 'pending' } })).toEqual([])
    expect(matcherReadLines({ ...run, matcher: null })).toEqual([])
  })

  it('shows the warm per-card time, the index build, the setup and the missing printed totals in the timing line', () => {
    const text = matcherTimingText(run)
    expect(text).toContain('index build 1,200')
    expect(text).toContain('warm per card 4,300 ms')
    expect(text).toContain('setup 786 ms (not per card)')
    expect(text).toContain('100 cards lack a printed total')
  })

  it('lists a WebGPU step test with its step times (not as a speed run with empty numbers), and shows GPU trouble in red', () => {
    const diag = { id: 'y', at: '2026-11-13T09:20:00', by: 'oak', has_photo: false, device: { ios: '26.6', gpuDiag: 'worker: navigator.gpu ok · session ok', gpuEvents: 'device lost (unknown): The GPU process crashed' }, timings: { gpudiag_worker_session_ms: 1918, gpudiag_worker_first_embedding_ms: 87 } }
    expect(gpuDiagText(diag)).toBe('WebGPU test, worker: navigator.gpu ok · session ok (session 1,918 ms · first embedding 87 ms)')
    const html = render(<PhoneSpeedRuns runs={[diag]} />)
    expect(html).toContain('WebGPU step test')
    expect(html).toContain('session 1,918 ms')
    expect(html).toContain('GPU trouble: device lost (unknown): The GPU process crashed')
    expect(html).not.toContain('embed – ms')
    expect(gpuDiagText({ device: {} })).toBeNull()
  })
})
