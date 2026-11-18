import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import en from '../i18n/en'
import { CheckThisCardBadge, ForcedPickHint, isForcedPick, isNoCandidate } from './ForcedPickNotice'
import { ScanItemPanel } from './ScanReview'

vi.mock('./CardImage', () => ({ default: () => null }))

const t = key => key.split('.').reduce((value, part) => value?.[part], en) ?? key

const matches = [1, 2, 3].map(n => ({ id: `m${n}`, tcg_card_id: `tst-${n}`, name: `Mon ${n}`, number: String(n), image: `https://img.example/${n}.webp` }))
const base = { id: 7, position: 0, status: 'done', resolved: false, has_image: true, matches }
const forced = { ...base, recognized: { language: 'en', _picture: { path: 'forced', matcher_only: true, forced_pick: true, forced_card: 'tst-1' } } }

function render(item) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ScanItemPanel jobId={1} item={item} onAdd={() => {}} onRetry={() => {}} onWait={() => {}} onDismiss={() => {}} onReview={() => {}} t={t} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Scan review: Matcher only', () => {
  it('marks an unsure proposal with "Check this card" and lists the alternatives as tappable cards', () => {
    const html = render(forced)
    expect(html).toContain('data-testid="scan-check-this-card"')
    expect(html).toContain('Check this card')
    expect(html).toContain('data-testid="scan-forced-hint"')
    expect(html).toContain('Mon 1')
    expect(html).toContain('Mon 2')
    expect(html).toContain('Mon 3')
    expect(html).not.toContain('Wait for the scanner')
  })

  it('looks as today for a decided result and for an ordinary scan', () => {
    const decided = { ...base, recognized: { name: 'Mon 1', _picture: { path: 'decided', matcher_only: true, forced_pick: false } } }
    expect(render(decided)).not.toContain('Check this card')
    expect(render({ ...base, recognized: { name: 'Mon 1' } })).not.toContain('Check this card')
  })

  it('shows nothing once the scan is resolved', () => {
    expect(render({ ...forced, resolved: true })).not.toContain('Check this card')
  })

  it('reads the flags only from a finished, unreviewed scan', () => {
    expect(isForcedPick(forced)).toBe(true)
    expect(isForcedPick({ ...forced, status: 'processing' })).toBe(false)
    expect(isForcedPick({ ...forced, resolved: true })).toBe(false)
    expect(isForcedPick(base)).toBe(false)
    const none = { ...base, matches: [], recognized: { _picture: { path: 'no_candidate', matcher_only: true, forced_pick: false } } }
    expect(isNoCandidate(none)).toBe(true)
    expect(isNoCandidate(forced)).toBe(false)
  })

  it('renders the badge and hint on their own, in plain words', () => {
    const html = renderToStaticMarkup(<><CheckThisCardBadge t={t} /><ForcedPickHint t={t} /></>)
    expect(html).toContain('Check this card')
    expect(html).toContain('Only English cards are matched')
  })
})
