import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import en from '../i18n/en'
import { ScanItemPanel } from './ScanReview'

vi.mock('./CardImage', () => ({ default: () => null }))

const t = key => key.split('.').reduce((value, part) => value?.[part], en) ?? key

const match = { id: 'a', tcg_card_id: 'tst-1', name: 'Mon 1', number: '1', image: 'https://img.example/1.webp' }

function render(item, props = {}) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ScanItemPanel jobId={1} item={item} onAdd={() => {}} onRetry={() => {}} onWait={() => {}} onDismiss={() => {}} onReview={() => {}} t={t} {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const base = { id: 7, position: 0, status: 'done', resolved: false, has_image: true, matches: [match] }

describe('Scan review: picture match first', () => {
  it('shows the unsure line and the Wait for the scanner button for an inbox scan', () => {
    const html = render({ ...base, recognized: { _picture: { path: 'unsure_inbox' } } })
    expect(html).toContain('Not sure which card this is. Pick it below, or wait for the scanner.')
    expect(html).toContain('Wait for the scanner')
    expect(html).not.toMatch(/\bPC\b/)
  })

  it('shows "Matched by picture" to admins only', () => {
    const item = { ...base, recognized: { name: 'Mon 1', _picture: { path: 'decided' } } }
    expect(render(item, { isAdmin: true })).toContain('Matched by picture')
    expect(render(item, { isAdmin: false })).not.toContain('Matched by picture')
  })

  it('shows nothing extra for an ordinary scan', () => {
    const html = render({ ...base, recognized: { name: 'Mon 1' } }, { isAdmin: true })
    expect(html).not.toContain('Matched by picture')
    expect(html).not.toContain('Wait for the scanner')
  })

  it('shows the waiting state in plain words once the scan waits', () => {
    const html = render({ ...base, status: 'retrying', retry_reason: 'scanner_unreachable', recognized: { _picture: { path: 'unsure_inbox', wait: true } } })
    expect(html).toContain('Waiting for the scanner')
    expect(html).not.toContain('Not sure which card')
  })
})
