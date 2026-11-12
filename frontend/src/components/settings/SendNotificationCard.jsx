import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import toast from 'react-hot-toast'
import { getUsers } from '../../api/client'
import { getAdminNotifications, sendAdminNotification } from '../../api/adminNotifications'
import { useSettings } from '../../contexts/SettingsContext'
import SegmentedControl from '../ios/SegmentedControl'

export const MAX_TITLE = 60
export const MAX_BODY = 240

/** The pages an announcement may open: a fixed list, never free-text URLs. Mirrors the server's allow-list. */
export const ANNOUNCEMENT_ROUTES = [
  { value: '/', labelKey: 'adminNotify.routes.home' },
  { value: '/sets', labelKey: 'adminNotify.routes.sets' },
  { value: '/wishlist', labelKey: 'adminNotify.routes.wishlist' },
  { value: '/collection', labelKey: 'adminNotify.routes.collection' },
  { value: '/scans', labelKey: 'adminNotify.routes.scans' },
  { value: '/achievements', labelKey: 'adminNotify.routes.achievements' },
  { value: '/leaderboard/activity', labelKey: 'adminNotify.routes.activity' },
]

const clean = text => String(text ?? '').split(/\s+/).filter(Boolean).join(' ')

/** True when the form may be previewed and sent. */
export function canSend({ title, body, mode, chosen }) {
  const t = clean(title)
  const b = clean(body)
  if (!t || t.length > MAX_TITLE || !b || b.length > MAX_BODY) return false
  return mode === 'all' || chosen.length > 0
}

/** How many trainers the send is addressed to. */
export function recipientCount({ mode, chosen, users }) {
  return mode === 'all' ? users.length : chosen.length
}

/** The `recipients` value of the API call. */
export function recipientsPayload({ mode, chosen }) {
  return mode === 'all' ? 'all' : chosen
}

function fill(text, values) {
  return Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, value), text)
}

/** The outcome line after a send. */
export function resultText(result, t) {
  const base = fill(t('adminNotify.sent'), { queued: result.queued })
  return result.skipped > 0 ? `${base} ${fill(t('adminNotify.skipped'), { skipped: result.skipped })}` : base
}

function whenText(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : format(date, 'd MMM yyyy, HH:mm')
}

export function PushPreview({ title, body, t }) {
  return (
    <div className="rounded-2xl bg-fill-tertiary p-3" data-testid="admin-notify-preview" aria-label={t('adminNotify.previewLabel')}>
      <p className="text-caption-1 uppercase tracking-wide text-text-muted">PokéCollector</p>
      <p className="text-subheadline font-semibold text-text-primary" style={{ overflowWrap: 'anywhere' }}>
        {clean(title) || t('adminNotify.titleLabel')}
      </p>
      <p className="text-footnote text-text-secondary" style={{ overflowWrap: 'anywhere' }}>
        {clean(body) || t('adminNotify.bodyLabel')}
      </p>
    </div>
  )
}

export function HistoryList({ entries, t }) {
  if (!entries.length) return <p className="px-4 py-3 text-footnote text-text-secondary">{t('adminNotify.historyEmpty')}</p>
  return (
    <ul className="divide-y-[0.5px] divide-border" data-testid="admin-notify-history">
      {entries.map(entry => (
        <li key={entry.id} className="space-y-0.5 px-4 py-3" data-testid="admin-notify-entry">
          <p className="text-body font-semibold" style={{ overflowWrap: 'anywhere' }}>{entry.title}</p>
          <p className="text-footnote text-text-secondary" style={{ overflowWrap: 'anywhere' }}>{entry.body}</p>
          <p className="text-caption-1 text-text-muted">
            {entry.sent_by} · {whenText(entry.created_at)} ·{' '}
            {fill(t('adminNotify.historyCounts'), { queued: entry.queued_count, total: entry.recipient_count })}
          </p>
        </li>
      ))}
    </ul>
  )
}

export default function SendNotificationCard() {
  const { t } = useSettings()
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [route, setRoute] = useState('/')
  const [mode, setMode] = useState('all')
  const [chosen, setChosen] = useState([])
  const [confirming, setConfirming] = useState(false)

  const { data: allUsers = [] } = useQuery({ queryKey: ['users'], queryFn: getUsers })
  const users = allUsers.filter(user => user.is_active !== false)
  const history = useQuery({ queryKey: ['admin-notifications'], queryFn: getAdminNotifications })

  const ready = canSend({ title, body, mode, chosen })
  const count = recipientCount({ mode, chosen, users })

  const mutation = useMutation({
    mutationFn: () => sendAdminNotification({
      title: clean(title), body: clean(body), route, recipients: recipientsPayload({ mode, chosen }),
    }),
    onSuccess: result => {
      toast.success(resultText(result, t))
      setTitle('')
      setBody('')
      setRoute('/')
      setMode('all')
      setChosen([])
      setConfirming(false)
      queryClient.invalidateQueries({ queryKey: ['admin-notifications'] })
      queryClient.invalidateQueries({ queryKey: ['audit-log'] })
    },
    onError: error => {
      const detail = error?.response?.data?.detail
      toast.error(typeof detail === 'string' ? detail : t('adminNotify.failed'))
      setConfirming(false)
    },
  })

  const toggle = id => setChosen(list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))

  return (
    <section className="space-y-1" data-testid="send-notification">
      <h2 className="px-4 pb-1.5 text-footnote text-text-secondary">{t('adminNotify.title')}</h2>
      <div className="space-y-4 overflow-hidden rounded-xl bg-card p-4">
        <p className="text-footnote text-text-secondary">{t('adminNotify.intro')}</p>

        <label className="block space-y-1">
          <span className="text-subheadline font-semibold">{t('adminNotify.titleLabel')}</span>
          <input
            className="input w-full" value={title} maxLength={MAX_TITLE} data-testid="admin-notify-title"
            onChange={event => { setTitle(event.target.value); setConfirming(false) }}
          />
          <span className="block text-right text-caption-1 text-text-muted">{title.length}/{MAX_TITLE}</span>
        </label>

        <label className="block space-y-1">
          <span className="text-subheadline font-semibold">{t('adminNotify.bodyLabel')}</span>
          <textarea
            className="input w-full" rows={3} value={body} maxLength={MAX_BODY} data-testid="admin-notify-body"
            onChange={event => { setBody(event.target.value); setConfirming(false) }}
          />
          <span className="block text-right text-caption-1 text-text-muted" data-testid="admin-notify-counter">
            {body.length}/{MAX_BODY}
          </span>
        </label>

        <label className="block space-y-1">
          <span className="text-subheadline font-semibold">{t('adminNotify.opensLabel')}</span>
          <select
            className="select w-full text-body" value={route} data-testid="admin-notify-route"
            onChange={event => setRoute(event.target.value)}
          >
            {ANNOUNCEMENT_ROUTES.map(option => <option key={option.value} value={option.value}>{t(option.labelKey)}</option>)}
          </select>
        </label>

        <div className="space-y-2">
          <span className="text-subheadline font-semibold">{t('adminNotify.recipientsLabel')}</span>
          <SegmentedControl
            ariaLabel={t('adminNotify.recipientsLabel')}
            value={mode}
            onChange={value => { setMode(value); setConfirming(false) }}
            options={[
              { value: 'all', label: t('adminNotify.everyone') },
              { value: 'some', label: t('adminNotify.chooseTrainers') },
            ]}
          />
          {mode === 'some' && (
            <ul className="max-h-56 overflow-y-auto rounded-lg border-[0.5px] border-border" data-testid="admin-notify-trainers">
              {users.map(user => (
                <li key={user.id} className="border-t-[0.5px] border-border first:border-t-0">
                  <label className="flex min-h-[44px] items-center gap-3 px-3">
                    <input
                      type="checkbox" checked={chosen.includes(user.id)}
                      onChange={() => { toggle(user.id); setConfirming(false) }}
                    />
                    <span className="text-body">{user.username}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <PushPreview title={title} body={body} t={t} />

        {confirming ? (
          <div className="space-y-3" data-testid="admin-notify-confirm">
            <p className="text-subheadline">{fill(t('adminNotify.confirm'), { count })}</p>
            <div className="flex gap-3">
              <button type="button" className="btn-secondary flex-1 justify-center" onClick={() => setConfirming(false)}>
                {t('adminNotify.cancel')}
              </button>
              <button
                type="button" className="btn-primary flex-1 justify-center" disabled={mutation.isPending}
                data-testid="admin-notify-send" onClick={() => mutation.mutate()}
              >
                {t('adminNotify.send')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button" className="btn-primary w-full justify-center" disabled={!ready}
            data-testid="admin-notify-review" onClick={() => setConfirming(true)}
          >
            {t('adminNotify.review')}
          </button>
        )}
      </div>

      <h2 className="px-4 pb-1.5 pt-4 text-footnote text-text-secondary">{t('adminNotify.historyTitle')}</h2>
      <div className="overflow-hidden rounded-xl bg-card">
        <HistoryList entries={history.data?.entries ?? []} t={t} />
      </div>
    </section>
  )
}
