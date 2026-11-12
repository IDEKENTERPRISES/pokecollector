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

  it('shows the page to an admin, with a camera input that never uploads and the remove button', () => {
    const html = render(<PhoneSpeedTest />)
    expect(html).toContain('Phone speed test')
    expect(html).toContain('capture="environment"')
    expect(html).toContain('never uploaded')
    expect(html).toContain('Remove test files')
    expect(html).toContain('cannot be read on iOS')
  })

  it('shows nothing to a trainer (it sends them back to Settings)', () => {
    auth.user = { role: 'trainer' }
    const html = render(<PhoneSpeedTest />)
    expect(html).not.toContain('Phone speed test')
    expect(html).not.toContain('phone-speed-page')
  })

  it('lists the last runs in Scanner lab with the link to the page', () => {
    const html = render(<PhoneSpeedRuns runs={[{
      at: '2026-11-13T09:15:00+00:00', by: 'oak', device: { ios: '18.2', gpu: true, crashedBefore: true },
      timings: { embed_wasm_median_ms: 410, card_wasm_median_ms: 2900, estimate_card_wasm_ms: 3800, estimate_card_webgpu_fp16_ms: 900 },
    }]} />)
    expect(html).toContain('href="/settings/phone-speed"')
    expect(html).toContain('2026-11-13 09:15')
    expect(html).toContain('2,900 ms')
    expect(html).toContain('GPU 900 ms')
    expect(html).toContain('crashed before')
    expect(render(<PhoneSpeedRuns runs={[]} />)).toContain('No runs yet')
  })

  it('shows first run and median per step, and an error where a step failed', () => {
    const html = render(<ResultsTable steps={[['a', 'Step A'], ['b', 'Step B'], ['c', 'Step C']]} rows={{ a: { first: 1200, median: 800 }, b: { error: 'unsupported operator ConvInteger' } }} />)
    expect(html).toContain('1,200 ms')
    expect(html).toContain('800 ms')
    expect(html).toContain('unsupported operator ConvInteger')
  })
})
