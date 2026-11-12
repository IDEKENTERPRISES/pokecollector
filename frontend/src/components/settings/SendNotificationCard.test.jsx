import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import en from '../../i18n/en'
import { visibleSettingsSections } from '../../navigation/navConfig'
import {
  ANNOUNCEMENT_ROUTES, HistoryList, MAX_BODY, MAX_TITLE, PushPreview, canSend, confirmNotes, deliveryText, recipientCount, recipientsPayload, resultText,
  waitingTime,
} from './SendNotificationCard'

const t = key => key.split('.').reduce((node, part) => node?.[part], en) ?? key

describe('canSend', () => {
  const base = { title: 'Hello', body: 'World', mode: 'all', chosen: [] }

  it('needs a title and a message', () => {
    expect(canSend(base)).toBe(true)
    expect(canSend({ ...base, title: '   ' })).toBe(false)
    expect(canSend({ ...base, body: '' })).toBe(false)
  })

  it('enforces the length limits', () => {
    expect(canSend({ ...base, title: 'x'.repeat(MAX_TITLE) })).toBe(true)
    expect(canSend({ ...base, title: 'x'.repeat(MAX_TITLE + 1) })).toBe(false)
    expect(canSend({ ...base, body: 'y'.repeat(MAX_BODY) })).toBe(true)
    expect(canSend({ ...base, body: 'y'.repeat(MAX_BODY + 1) })).toBe(false)
  })

  it('needs at least one trainer when choosing', () => {
    expect(canSend({ ...base, mode: 'some', chosen: [] })).toBe(false)
    expect(canSend({ ...base, mode: 'some', chosen: [2] })).toBe(true)
  })
})

describe('recipients', () => {
  const users = [{ id: 1 }, { id: 2 }, { id: 3 }]

  it('counts everyone or the chosen trainers', () => {
    expect(recipientCount({ mode: 'all', chosen: [], users })).toBe(3)
    expect(recipientCount({ mode: 'some', chosen: [1, 3], users })).toBe(2)
  })

  it('sends "all" or the chosen ids', () => {
    expect(recipientsPayload({ mode: 'all', chosen: [1] })).toBe('all')
    expect(recipientsPayload({ mode: 'some', chosen: [1, 3] })).toEqual([1, 3])
  })
})

describe('the Opens list', () => {
  it('is a fixed list of app routes starting with Home', () => {
    expect(ANNOUNCEMENT_ROUTES[0].value).toBe('/')
    for (const option of ANNOUNCEMENT_ROUTES) {
      expect(option.value.startsWith('/')).toBe(true)
      expect(option.value).not.toContain('://')
      expect(t(option.labelKey)).not.toBe(option.labelKey)
    }
  })
})

describe('resultText', () => {
  it('names the queued count and only mentions skips when there are some', () => {
    expect(resultText({ queued: 3, skipped: 0 }, t)).toBe('Queued for 3 trainer(s).')
    expect(resultText({ queued: 2, skipped: 1 }, t)).toContain('1 skipped')
  })
})

describe('preview and history', () => {
  it('shows the push as it will look', () => {
    const markup = renderToStaticMarkup(createElement(PushPreview, { title: ' Big  news ', body: 'Open the app', t }))
    expect(markup).toContain('Big news')
    expect(markup).toContain('Open the app')
  })

  it('lists the sends with their counts', () => {
    const entries = [{
      id: 1, title: 'Maintenance', body: 'Back at noon', sent_by: 'admin', created_at: '2026-11-12T10:00:00Z',
      recipient_count: 4, queued_count: 3, sent: 2, waiting: 1, waiting_until: '2026-11-13T08:00:00Z',
      skipped_count: 1, urgent: false,
    }]
    const markup = renderToStaticMarkup(createElement(HistoryList, { entries, t }))
    expect(markup).toContain('Maintenance')
    expect(markup).toContain('To 4 trainer(s)')
    expect(markup).toContain('2 sent')
    expect(markup).toContain('1 waiting until')
    expect(markup).toContain('1 skipped')
    expect(renderToStaticMarkup(createElement(HistoryList, { entries: [], t }))).toContain('Nothing has been sent yet.')
  })
})

describe('Administrator section visibility', () => {
  it('is only listed for administrators', () => {
    expect(visibleSettingsSections({ isAdmin: true }).map(s => s.key)).toContain('admin')
    expect(visibleSettingsSections({ isAdmin: false }).map(s => s.key)).not.toContain('admin')
  })
})

describe('delivery status', () => {
  const now = new Date(2026, 10, 12, 2, 40)

  it('shows sent, waiting and skipped, leaving out empty parts', () => {
    const waiting = new Date(2026, 10, 12, 8, 0).toISOString()
    expect(deliveryText({ sent: 1, waiting: 1, waiting_until: waiting, skipped_count: 0 }, t, now)).toBe('1 sent · 1 waiting until 08:00')
    expect(deliveryText({ sent: 3, waiting: 0, skipped_count: 2 }, t, now)).toBe('3 sent · 2 skipped')
    expect(deliveryText({ sent: 0, waiting: 0, skipped_count: 0 }, t, now)).toBe('Nothing queued')
  })

  it('adds the date when the wait ends on another day', () => {
    expect(waitingTime(new Date(2026, 10, 13, 8, 0).toISOString(), now)).toBe('13 Nov 08:00')
    expect(waitingTime('nonsense', now)).toBe('')
  })
})

describe('confirmation notes', () => {
  it('says an urgent send ignores quiet hours', () => {
    expect(confirmNotes({ urgent: true, quietNow: 3 }, t)).toEqual(['Sends now, even to trainers in quiet hours.'])
  })

  it('says how many will wait until 08:00 when not urgent', () => {
    expect(confirmNotes({ urgent: false, quietNow: 2 }, t)).toEqual(['2 trainer(s) are in quiet hours and will get it at 08:00.'])
    expect(confirmNotes({ urgent: false, quietNow: 0 }, t)).toEqual([])
  })

  it('has the urgent switch strings', () => {
    expect(t('adminNotify.urgentLabel')).toBe('Send now, even during quiet hours')
  })
})
