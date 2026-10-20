import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { getAuditLog } from '../../api/invites'
import { useSettings } from '../../contexts/SettingsContext'
import PageSheet from '../ios/PageSheet'

/** The label of an audit action (keys use underscores: `invite.created` is `invite_created`). */
export function auditActionLabel(action, t) {
  const key = `audit.actions.${String(action).replaceAll('.', '_')}`
  const label = t(key)
  return label === key ? action : label
}

/** One short line of detail for an entry, from the fields the server stored. */
export function auditDetailText(entry, t) {
  const details = entry.details || {}
  const parts = []
  if (details.reason) parts.push(t('audit.details.reason').replace('{reason}', t(`invites.page.reasons.${details.reason}`) || details.reason))
  if (details.role) parts.push(t('audit.details.role').replace('{role}', details.role))
  if (entry.action === 'invite.accepted' && details.username) {
    parts.push(t('audit.details.newUser').replace('{name}', details.username))
  }
  if (details.note) parts.push(`“${details.note}”`)
  return parts.join(' · ')
}

function formatWhen(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : format(date, 'd MMM yyyy, HH:mm')
}

/** The audit log in a page sheet, newest first, loaded a page at a time. */
export default function AuditLogSheet({ isOpen, onClose }) {
  const { t } = useSettings()
  const [pageSize] = useState(25)
  const query = useInfiniteQuery({
    queryKey: ['audit-log', pageSize],
    queryFn: ({ pageParam }) => getAuditLog({ limit: pageSize, before: pageParam }),
    initialPageParam: undefined,
    getNextPageParam: last => last.next_before ?? undefined,
    enabled: isOpen,
  })
  const entries = query.data?.pages.flatMap(page => page.entries) ?? []

  return (
    <PageSheet
      isOpen={isOpen}
      onClose={onClose}
      title={t('audit.title')}
      leading={<span />}
      trailing={{ label: t('ios.done'), onPress: onClose }}
    >
      <div className="space-y-3 p-4" data-testid="audit-log">
        {query.isError && <p className="text-subheadline text-red">{t('audit.loadFailed')}</p>}
        {!query.isError && !query.isLoading && entries.length === 0 && (
          <p className="text-subheadline text-text-secondary">{t('audit.empty')}</p>
        )}
        <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card">
          {entries.map(entry => {
            const detail = auditDetailText(entry, t)
            return (
              <li key={entry.id} className="space-y-0.5 px-4 py-3" data-testid="audit-entry">
                <p className="text-body font-semibold">{auditActionLabel(entry.action, t)}</p>
                <p className="text-footnote text-text-secondary">
                  {entry.actor_username || t('audit.system')} · {formatWhen(entry.created_at)}
                </p>
                {detail && <p className="text-footnote text-text-secondary">{detail}</p>}
                {entry.ip && <p className="text-caption-1 text-text-muted">{t('audit.from').replace('{ip}', entry.ip)}</p>}
              </li>
            )
          })}
        </ul>
        {query.hasNextPage && (
          <button
            type="button"
            onClick={() => query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
            className="btn-secondary w-full justify-center"
          >
            {t('audit.loadMore')}
          </button>
        )}
      </div>
    </PageSheet>
  )
}
