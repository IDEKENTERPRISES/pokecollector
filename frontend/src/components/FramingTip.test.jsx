import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import en from '../i18n/en'
import { FramingTip, hasRejectedOutline } from './ForcedPickNotice'
import { ScanItemPanel } from './ScanReview'

vi.mock('./CardImage', () => ({ default: () => null }))

const t = key => key.split('.').reduce((value, part) => value?.[part], en) ?? key

const matches = [1, 2].map(n => ({ id: `m${n}`, tcg_card_id: `tst-${n}`, name: `Mon ${n}`, number: String(n), image: `https://img.example/${n}.webp` }))
const base = { id: 7, position: 0, status: 'done', resolved: false, has_image: true, matches }

function render(item) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ScanItemPanel jobId={1} item={item} onAdd={() => {}} onRetry={() => {}} onWait={() => {}} onDismiss={() => {}} onReview={() => {}} t={t} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Scan framing tip', () => {
  it('has short English wording', () => {
    expect(en.scanner.framingGuide).toBe('Keep the whole card inside the frame with a little space around it.')
    expect(renderToStaticMarkup(<FramingTip t={t} />)).toContain('scan the card on its own')
  })

  it('reads the rejected-outline flag from the scan result', () => {
    expect(hasRejectedOutline({ _picture: { outline_rejected: 'touches_edges' } })).toBe(true)
    expect(hasRejectedOutline({ _picture: { path: 'forced' } })).toBe(false)
    expect(hasRejectedOutline(undefined)).toBe(false)
  })

  it('shows the tip in the review only when the outline was rejected, and never blocks the candidates', () => {
    const rejected = { ...base, recognized: { _picture: { path: 'forced', forced_pick: true, outline_rejected: 'touches_edges' } } }
    const html = render(rejected)
    expect(html).toContain('data-testid="scan-framing-tip"')
    expect(html).toContain('Mon 1')
    expect(render({ ...base, recognized: { _picture: { path: 'forced', forced_pick: true } } })).not.toContain('scan-framing-tip')
  })
})
