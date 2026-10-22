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

const PROVIDER_NAMES = { gemini: 'Gemini', openai: 'OpenAI' }

function scannerValue(field, value, t) {
  if (value === null || value === undefined || value === '') return t('audit.details.none')
  if (field === 'capability') {
    return t(value === 'full' ? 'audit.details.verificationOn' : 'audit.details.verificationOff')
  }
  if (field === 'provider') return PROVIDER_NAMES[value] || String(value)
  return String(value)
}

/** The lines of a scanner configuration change: each field as before → after, keys by last four only. */
function scannerChangeLines(details, t) {
  const changes = details.changes || {}
  const lines = []
  const fill = (key, values) => Object.entries(values).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, value),
    t(key),
  )
  if (changes.provider) {
    lines.push(fill('audit.details.scannerProvider', {
      from: scannerValue('provider', changes.provider.from, t),
      to: scannerValue('provider', changes.provider.to, t),
    }))
  }
  if (changes.model) {
    lines.push(fill('audit.details.scannerModel', {
      from: scannerValue('model', changes.model.from, t),
      to: scannerValue('model', changes.model.to, t),
    }))
  }
  if (changes.request_timeout) {
    lines.push(fill('audit.details.scannerTimeout', {
      from: scannerValue('timeout', changes.request_timeout.from, t),
      to: scannerValue('timeout', changes.request_timeout.to, t),
    }))
  }
  if (changes.gemini_fallback) {
    lines.push(fill('audit.details.scannerFallback', {
      state: t(changes.gemini_fallback.to ? 'audit.details.on' : 'audit.details.off'),
    }))
  }
  if (changes.capability) {
    lines.push(fill('audit.details.scannerVerification', {
      from: scannerValue('capability', changes.capability.from, t),
      to: scannerValue('capability', changes.capability.to, t),
    }))
  }
  for (const [provider, key] of Object.entries(changes.api_key || {})) {
    const action = ['added', 'replaced', 'removed'].includes(key.action) ? key.action : 'replaced'
    lines.push(fill(`audit.details.key_${action}`, {
      provider: PROVIDER_NAMES[provider] || provider,
      from: key.from || '',
      to: key.to || '',
    }))
  }
  if (details.copied_from?.username) {
    lines.push(fill('audit.details.copiedFrom', { name: details.copied_from.username }))
  }
  return lines
}

/** The short readable lines of detail for an entry, from the fields the server stored. */
export function auditDetailLines(entry, t) {
  if (entry.action === 'scanner.config.updated') return scannerChangeLines(entry.details || {}, t)
  const text = auditDetailText(entry, t)
  return text ? [text] : []
}

/** One short line of detail for an entry, from the fields the server stored. */
export function auditDetailText(entry, t) {
  if (entry.action === 'scanner.config.updated') return auditDetailLines(entry, t).join(' · ')
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
            const detailLines = auditDetailLines(entry, t)
            return (
              <li key={entry.id} className="space-y-0.5 px-4 py-3" data-testid="audit-entry">
                <p className="text-body font-semibold">{auditActionLabel(entry.action, t)}</p>
                <p className="text-footnote text-text-secondary">
                  {entry.actor_username || t('audit.system')} · {formatWhen(entry.created_at)}
                </p>
                {detailLines.map(line => <p key={line} className="text-footnote text-text-secondary">{line}</p>)}
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
