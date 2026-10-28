import Switch from '../ios/Switch'

// Per-user notification categories (engagement P4). Defaults mirror services/notifications.py;
// the server also returns them in /api/settings, so this only matters before settings load.
export const NOTIFY_CATEGORIES = [
  { id: 'scans_ready', fallback: true, label: 'notifyPrefs.scansReady', desc: 'notifyPrefs.scansReadyDesc' },
  { id: 'wishlist_alerts', fallback: true, label: 'notifyPrefs.wishlistAlerts', desc: 'notifyPrefs.wishlistAlertsDesc' },
  { id: 'new_sets', fallback: true, label: 'notifyPrefs.newSets', desc: 'notifyPrefs.newSetsDesc' },
  { id: 'wishlist_dips', fallback: true, label: 'notifyPrefs.wishlistDips', desc: 'notifyPrefs.wishlistDipsDesc' },
  { id: 'big_movers', fallback: false, label: 'notifyPrefs.bigMovers', desc: 'notifyPrefs.bigMoversDesc' },
]
export const DIGEST_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]

const isOn = (value, fallback) => (value == null ? fallback : String(value).toLowerCase() === 'true')

export function categoryEnabled(settings, category) {
  return isOn(settings?.[`notify_${category.id}`], category.fallback)
}

export function digestHour(settings) {
  const hour = parseInt(settings?.notify_digest_hour, 10)
  return DIGEST_HOURS.includes(hour) ? hour : 18
}

export const quietHoursEnabled = settings => isOn(settings?.notify_quiet_hours, true)

const pad = hour => `${String(hour).padStart(2, '0')}:00`

function Row({ label, description, children }) {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-3 border-t-[0.5px] border-border px-4 py-[11px] first:border-t-0">
      <div className="min-w-0 flex-1">
        <p className="text-body text-text-primary">{label}</p>
        <p className="mt-0.5 text-footnote text-text-secondary" style={{ overflowWrap: 'anywhere' }}>{description}</p>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}

/** Category switches, digest time and quiet hours. `save` takes a settings patch and may reject. */
export default function NotificationPrefs({ settings, save, t }) {
  const update = patch => Promise.resolve(save(patch)).catch(() => {})
  return (
    <div data-testid="notification-prefs" className="space-y-1">
      <p className="px-4 pb-1.5 text-footnote text-text-secondary">{t('notifyPrefs.categoriesTitle')}</p>
      <div className="overflow-hidden rounded-xl bg-card">
        {NOTIFY_CATEGORIES.map(category => (
          <Row key={category.id} label={t(category.label)} description={t(category.desc)}>
            <Switch
              checked={categoryEnabled(settings, category)}
              label={t(category.label)}
              onChange={next => update({ [`notify_${category.id}`]: next ? 'true' : 'false' })}
            />
          </Row>
        ))}
        <Row label={t('notifyPrefs.digestTime')} description={t('notifyPrefs.digestTimeDesc')}>
          <select
            className="select text-body"
            aria-label={t('notifyPrefs.digestTime')}
            value={digestHour(settings)}
            onChange={e => update({ notify_digest_hour: e.target.value })}
          >
            {DIGEST_HOURS.map(hour => <option key={hour} value={hour}>{pad(hour)}</option>)}
          </select>
        </Row>
        <Row label={t('notifyPrefs.quietHours')} description={t('notifyPrefs.quietHoursDesc')}>
          <Switch
            checked={quietHoursEnabled(settings)}
            label={t('notifyPrefs.quietHours')}
            onChange={next => update({ notify_quiet_hours: next ? 'true' : 'false' })}
          />
        </Row>
      </div>
      <p className="px-4 pt-1 text-footnote text-text-secondary">{t('notifyPrefs.badgeNote')}</p>
    </div>
  )
}
