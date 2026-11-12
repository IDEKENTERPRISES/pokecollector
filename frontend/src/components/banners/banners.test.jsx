import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import en from '../../i18n/en'

const t = key => key.split('.').reduce((node, part) => node?.[part], en) ?? key

vi.mock('../../contexts/SettingsContext', () => ({ useSettings: () => ({ t }) }))

const { default: BannerView, MAX_VISIBLE_BANNERS, overflowCount, spriteUrl } = await import('./BannerView')
const { BannerStack } = await import('./HomeBanners')
const {
  BannerList, MAX_MESSAGE, MAX_NAME, buildPayload, canSave, emptyForm, formFromBanner, previewBanner, toLocalInput,
} = await import('../settings/BannerCard')
const { auditActionLabel, auditDetailText } = await import('../settings/AuditLogSheet')

const banner = (id, extra = {}) => ({
  id, label: 'admin', sender_name: `Sender ${id}`, avatar_id: 25, message: `Message ${id}`,
  style: 'info', route: null, dismissible: true, ...extra,
})

const render = element => renderToStaticMarkup(createElement(MemoryRouter, null, element))

describe('Home banner stack', () => {
  it('renders nothing without banners', () => {
    expect(render(createElement(BannerStack, { banners: [], onDismiss: () => {} }))).toBe('')
  })

  it('shows at most three cards and counts the rest', () => {
    const banners = [1, 2, 3, 4, 5].map(id => banner(id))
    const html = render(createElement(BannerStack, { banners, onDismiss: () => {} }))
    expect(html.match(/data-testid="banner-card"/g)).toHaveLength(MAX_VISIBLE_BANNERS)
    expect(html).toContain('and 2 more')
    expect(overflowCount(banners)).toBe(2)
    expect(html).not.toContain('Message 4')
  })

  it('sticks to the top of the screen under the nav bar', () => {
    const html = render(createElement(BannerStack, { banners: [banner(1)], onDismiss: () => {} }))
    expect(html).toMatch(/class="sticky /)
    expect(html).toContain('top:calc(var(--safe-top) + var(--navbar-height))')
  })

  it('shows sprite, sender, label, message and the link', () => {
    const html = render(createElement(BannerView, { banner: banner(1, { label: 'system', route: '/sets', style: 'alert' }) }))
    expect(html).toContain(spriteUrl(25))
    expect(html).toContain('Sender 1')
    expect(html).toContain('>System<')
    expect(html).toContain('Message 1')
    expect(html).toContain('href="/sets"')
    expect(html).toContain('data-style="alert"')
  })

  it('has a close button only when the banner can be dismissed', () => {
    const onDismiss = () => {}
    expect(render(createElement(BannerView, { banner: banner(1), onDismiss }))).toContain('banner-dismiss')
    expect(render(createElement(BannerView, { banner: banner(1, { dismissible: false }), onDismiss }))).not.toContain('banner-dismiss')
  })

  it('shows the message as plain text, never as HTML', () => {
    const html = render(createElement(BannerView, { banner: banner(1, { message: '<img src=x onerror=alert(1)>' }) }))
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img')
  })
})

describe('admin banner form', () => {
  const user = { username: 'admin', avatar_id: 25 }
  const ok = { ...emptyForm(user), message: 'Hello' }

  it('needs a message within the limit', () => {
    expect(canSave(ok)).toBe(true)
    expect(canSave({ ...ok, message: '  ' })).toBe(false)
    expect(canSave({ ...ok, message: 'x'.repeat(MAX_MESSAGE + 1) })).toBe(false)
  })

  it('prefills the sender name with the username and needs a name within the limit', () => {
    expect(ok.senderName).toBe('admin')
    expect(canSave({ ...ok, senderName: '' })).toBe(false)
    expect(canSave({ ...ok, senderName: '   ' })).toBe(false)
    expect(canSave({ ...ok, senderName: 'n'.repeat(MAX_NAME + 1) })).toBe(false)
    expect(canSave({ ...ok, senderName: 'n'.repeat(MAX_NAME) })).toBe(true)
    expect(canSave({ ...ok, senderName: 'Professor Oak' })).toBe(true)
  })

  it('needs a Pokemon when choosing one, and trainers when choosing some', () => {
    expect(canSave({ ...ok, avatarMode: 'pokemon' })).toBe(false)
    expect(canSave({ ...ok, avatarMode: 'pokemon', avatarId: 151 })).toBe(true)
    expect(canSave({ ...ok, avatarMode: 'pokemon', avatarId: 152 })).toBe(false)
    expect(canSave({ ...ok, audience: 'some', chosen: [] })).toBe(false)
    expect(canSave({ ...ok, audience: 'some', chosen: [2] })).toBe(true)
  })

  it('builds the API payload', () => {
    const payload = buildPayload({
      ...ok, message: '  Hi   there ', senderName: ' Prof  Oak ', avatarMode: 'pokemon', avatarId: 1,
      route: '/sets', audience: 'some', chosen: [2, 3], dismissible: false,
    })
    expect(payload).toMatchObject({
      message: 'Hi there', sender_name: 'Prof Oak', avatar_mode: 'pokemon', avatar_id: 1,
      route: '/sets', audience: 'some', user_ids: [2, 3], ends_at: null, dismissible: false,
    })
    expect(buildPayload(ok)).toMatchObject({ sender_name: 'admin', avatar_id: null, route: null, user_ids: [] })
  })

  it('round-trips an end time and an existing banner', () => {
    const iso = new Date(2030, 0, 2, 3, 4).toISOString()
    expect(toLocalInput(iso)).toBe('2030-01-02T03:04')
    expect(toLocalInput(null)).toBe('')
    const form = formFromBanner({
      message: 'm', sender_name: 'Professor Oak', avatar_mode: 'me', avatar_id: 25, style: 'warning',
      route: null, audience: 'all', user_ids: [], ends_at: iso, dismissible: true,
    })
    expect(form).toMatchObject({ senderName: 'Professor Oak', avatarId: null, style: 'warning', endsAt: '2030-01-02T03:04' })
    expect(new Date(buildPayload(form).ends_at).toISOString()).toBe(iso)
  })

  it('previews as me or as a custom sender', () => {
    expect(previewBanner(ok, user)).toMatchObject({ label: 'admin', sender_name: 'admin', avatar_id: 25 })
    expect(previewBanner({ ...ok, senderName: 'Oak', avatarMode: 'pokemon', avatarId: 7 }, user))
      .toMatchObject({ label: 'system', sender_name: 'Oak', avatar_id: 7 })
  })

  it('lists banners with their status and the Edit, End now and Delete buttons', () => {
    const entries = [
      { ...banner(1), status: 'active', audience: 'all', user_ids: [], ends_at: null },
      { ...banner(2), status: 'ended', audience: 'some', user_ids: [3], ends_at: null },
    ]
    const html = render(createElement(BannerList, { entries, t, onEdit() {}, onEnd() {}, onDelete() {} }))
    expect(html.match(/banner-edit/g)).toHaveLength(2)
    expect(html.match(/banner-delete"/g)).toHaveLength(2)
    expect(html.match(/banner-end/g)).toHaveLength(1)
    expect(html).toContain('1 trainer(s)')
    expect(render(createElement(BannerList, { entries: [], t }))).toContain('No banners yet.')
  })
})

describe('banner audit entries', () => {
  it('have readable labels', () => {
    expect(auditActionLabel('banner.created', t)).toBe('Banner created')
    expect(auditActionLabel('banner.updated', t)).toBe('Banner edited')
    expect(auditActionLabel('banner.ended', t)).toBe('Banner ended')
    expect(auditActionLabel('banner.deleted', t)).toBe('Banner deleted')
    expect(auditActionLabel('banner.dismissed', t)).toBe('Banner dismissed')
  })

  it('shows the custom name and the audience', () => {
    const line = auditDetailText({ action: 'banner.created', details: { sender_name: 'Professor Oak', audience: [2, 3] } }, t)
    expect(line).toBe('From Professor Oak · 2 trainer(s)')
    expect(auditDetailText({ action: 'banner.ended', details: { audience: 'all' } }, t)).toBe('Everyone')
  })
})
