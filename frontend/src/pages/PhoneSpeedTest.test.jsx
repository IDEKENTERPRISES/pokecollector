import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = { user: { role: 'admin' } }
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }))
vi.mock('../navigation/useNavBar', () => ({ useNavBar: () => {} }))
vi.mock('../api/client', () => ({ default: { get: vi.fn(() => new Promise(() => {})), post: vi.fn() } }))

const { default: PhoneSpeedTest, ResultsTable } = await import('./PhoneSpeedTest')
const { PhoneSpeedRuns } = await import('../components/settings/ScannerLabSection')

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

  it('offers the 8-bit WebGPU model only as an unchecked switch, and only where WebGPU exists', () => {
    vi.stubGlobal('navigator', { gpu: {}, userAgent: '' })
    const withGpu = render(<PhoneSpeedTest />)
    vi.unstubAllGlobals()
    expect(withGpu).toContain('Also try the 8-bit model on WebGPU (may crash)')
    expect(withGpu).toMatch(/<input type="checkbox"(?![^>]*checked)/)
    vi.stubGlobal('navigator', { userAgent: '' })
    const without = render(<PhoneSpeedTest />)
    vi.unstubAllGlobals()
    expect(without).not.toContain('8-bit model on WebGPU')
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
      compare: { in_use: { wasm: { top1_agree: true, phone_top1_in_server_top20: true, overlap: 14 } } },
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
