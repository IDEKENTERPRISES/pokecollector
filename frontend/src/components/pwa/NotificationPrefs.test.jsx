import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import NotificationPrefs, { categoryEnabled, digestHour, NOTIFY_CATEGORIES, quietHoursEnabled } from './NotificationPrefs'

const t = key => key
const switches = html => [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map(m => m[0])
const checkedOf = tag => /aria-checked="true"/.test(tag)

function findAll(node, predicate, out = []) {
  if (Array.isArray(node)) node.forEach(child => findAll(child, predicate, out))
  else if (node && typeof node === "object" && node.props) {
    if (predicate(node)) out.push(node)
    findAll(node.props.children, predicate, out)
  }
  return out
}

describe('NotificationPrefs', () => {
  it('uses the design defaults when nothing is stored', () => {
    expect(NOTIFY_CATEGORIES.map(c => [c.id, categoryEnabled({}, c)])).toEqual([
      ['scans_ready', true], ['wishlist_alerts', true], ['new_sets', true], ['wishlist_dips', true], ['big_movers', false], ['badges', true],
    ])
    expect(digestHour({})).toBe(18)
    expect(quietHoursEnabled({})).toBe(true)
  })

  it('renders one switch per category plus quiet hours, with their captions and the digest time', () => {
    const html = renderToStaticMarkup(<NotificationPrefs settings={{ notify_big_movers: 'true', notify_new_sets: 'false', notify_digest_hour: '9' }} save={vi.fn()} t={t} />)
    const tags = switches(html)
    expect(tags).toHaveLength(7)
    expect(tags.map(checkedOf)).toEqual([true, true, false, true, true, true, true])
    for (const key of ['notifyPrefs.scansReadyDesc', 'notifyPrefs.newSetsDesc', 'notifyPrefs.wishlistDipsDesc', 'notifyPrefs.bigMoversDesc', 'notifyPrefs.badgesDesc', 'notifyPrefs.digestTime', 'notifyPrefs.quietHoursDesc']) {
      expect(html).toContain(key)
    }
    expect(html).toContain('<option value="9" selected="">09:00</option>')
  })

  it("saves the flipped value when a switch is toggled", async () => {
    const save = vi.fn().mockResolvedValue({})
    const tree = NotificationPrefs({ settings: { notify_big_movers: "true" }, save, t })
    const toggles = findAll(tree, n => typeof n.props.onChange === "function" && n.props.label)
    expect(toggles.map(n => n.props.label)).toEqual(["notifyPrefs.scansReady", "notifyPrefs.wishlistAlerts", "notifyPrefs.newSets", "notifyPrefs.wishlistDips", "notifyPrefs.bigMovers", "notifyPrefs.badges", "notifyPrefs.quietHours"])
    toggles[0].props.onChange(false)
    toggles[4].props.onChange(false)
    toggles[6].props.onChange(false)
    expect(save.mock.calls).toEqual([[{ notify_scans_ready: "false" }], [{ notify_big_movers: "false" }], [{ notify_quiet_hours: "false" }]])
    const select = findAll(tree, n => n.type === "select")[0]
    select.props.onChange({ target: { value: "20" } })
    expect(save).toHaveBeenLastCalledWith({ notify_digest_hour: "20" })
  })

  it('clamps a stored digest hour that is outside the allowed window', () => {
    expect(digestHour({ notify_digest_hour: '23' })).toBe(18)
    expect(digestHour({ notify_digest_hour: 'x' })).toBe(18)
  })
})
