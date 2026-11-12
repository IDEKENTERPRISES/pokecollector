import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = { user: { role: 'admin' } }
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }))
vi.mock('../navigation/useNavBar', () => ({ useNavBar: () => {} }))
vi.mock('../api/client', () => ({ default: { get: vi.fn(() => new Promise(() => {})), post: vi.fn() } }))

const { default: PhoneSpeedTest, ResultsTable, MatcherResults, OcrStats, GpuDiagnosis } = await import('./PhoneSpeedTest')
const { PhoneSpeedRuns, matcherAgreementText, matcherTimingText } = await import('../components/settings/ScannerLabSection')

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
    expect(html).toContain('Total per card')
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
      name: { steps: [{ label: 'name-line', ms: 120 }] },
    }
    const html = render(<OcrStats stats={stats} />)
    expect(html).toContain('3 × 140 ms')
    expect(html).toContain('1x3x128x704')
    expect(html).toContain('4 × 32.5 ms')
    expect(html).toContain('3 of 6 steps ran')
    expect(html).toContain('stopped by the 0.9 s budget')
    expect(html).toContain('name-line 120 ms')
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
