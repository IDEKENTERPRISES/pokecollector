import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import en from '../../i18n/en'
import { visibleSettingsSections } from '../../navigation/navConfig'
import {
  ANNOUNCEMENT_ROUTES, HistoryList, MAX_BODY, MAX_TITLE, PushPreview, canSend, recipientCount, recipientsPayload, resultText,
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
      recipient_count: 4, queued_count: 3,
    }]
    const markup = renderToStaticMarkup(createElement(HistoryList, { entries, t }))
    expect(markup).toContain('Maintenance')
    expect(markup).toContain('3 of 4 queued')
    expect(renderToStaticMarkup(createElement(HistoryList, { entries: [], t }))).toContain('Nothing has been sent yet.')
  })
})

describe('Administrator section visibility', () => {
  it('is only listed for administrators', () => {
    expect(visibleSettingsSections({ isAdmin: true }).map(s => s.key)).toContain('admin')
    expect(visibleSettingsSections({ isAdmin: false }).map(s => s.key)).not.toContain('admin')
  })
})
