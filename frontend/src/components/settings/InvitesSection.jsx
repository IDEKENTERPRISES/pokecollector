import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { ClipboardList, Copy, Share, UserPlus } from 'lucide-react'
import toast from 'react-hot-toast'
import { createInvite, getInvites, inviteErrorMessage, inviteLink, revokeInvite } from '../../api/invites'
import { useSettings } from '../../contexts/SettingsContext'
import ActionSheet from '../ios/ActionSheet'
import ListRow from '../ios/ListRow'
import ListSection from '../ios/ListSection'
import PageSheet from '../ios/PageSheet'
import SegmentedControl from '../ios/SegmentedControl'
import AuditLogSheet from './AuditLogSheet'

const CHIP_CLASSES = {
  pending: 'bg-blue/20 text-blue',
  used: 'bg-green/20 text-green',
  expired: 'bg-fill-tertiary text-text-secondary',
  revoked: 'bg-red/20 text-red',
}

export function StatusChip({ status, label }) {
  return (
    <span
      data-testid="invite-status"
      data-status={status}
      className={`inline-flex flex-shrink-0 rounded-full px-2.5 py-0.5 text-caption-1 font-semibold ${CHIP_CLASSES[status] ?? CHIP_CLASSES.expired}`}
    >
      {label}
    </span>
  )
}

/** Copy `text`, with a fallback for browsers (and plain-HTTP origins) without the clipboard API. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const field = document.createElement('textarea')
    field.value = text
    field.setAttribute('readonly', '')
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.appendChild(field)
    field.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    field.remove()
    return ok
  }
}

function formatDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : format(date, 'd MMM yyyy')
}

function CreateInviteSheet({ isOpen, onClose }) {
  const { t } = useSettings()
  const queryClient = useQueryClient()
  const [role, setRole] = useState('trainer')
  const [days, setDays] = useState(7)
  const [note, setNote] = useState('')
  const [created, setCreated] = useState(null)

  const reset = () => {
    setRole('trainer')
    setDays(7)
    setNote('')
    setCreated(null)
  }
  const close = () => {
    onClose()
    reset()
  }

  const mutation = useMutation({
    mutationFn: () => createInvite({ role, expiresInDays: days, note: note.trim() || undefined }),
    onSuccess: data => {
      setCreated({ ...data, link: inviteLink(data.token) })
      queryClient.invalidateQueries({ queryKey: ['invites'] })
      queryClient.invalidateQueries({ queryKey: ['audit-log'] })
    },
    onError: error => toast.error(inviteErrorMessage(error, t('invites.createFailed'))),
  })

  const copyLink = async () => {
    if (await copyText(created.link)) toast.success(t('invites.copied'))
    else toast.error(t('invites.copyFailed'))
  }
  const share = async () => {
    try {
      await navigator.share({ title: 'PokéCollector', text: t('invites.shareText'), url: created.link })
    } catch (error) {
      // Dismissing the share sheet is not an error; anything else falls back to copying.
      if (error?.name !== 'AbortError') copyLink()
    }
  }

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

  return (
    <PageSheet
      isOpen={isOpen}
      onClose={close}
      title={created ? t('invites.linkTitle') : t('invites.createTitle')}
      leading={created ? <span /> : undefined}
      trailing={created
        ? { label: t('ios.done'), onPress: close }
        : { label: t('invites.createAction'), onPress: () => mutation.mutate(), disabled: mutation.isPending }}
    >
      {created ? (
        <div className="space-y-4 p-4">
          <p className="text-subheadline text-text-secondary">{t('invites.linkOnce')}</p>
          <input
            readOnly
            value={created.link}
            aria-label={t('invites.linkTitle')}
            data-testid="invite-link"
            onFocus={event => event.target.select()}
            className="input w-full"
          />
          <div className="flex gap-3">
            <button type="button" onClick={copyLink} className="btn-primary flex-1 justify-center gap-2" data-testid="invite-copy">
              <Copy size={16} aria-hidden="true" />
              {t('invites.copy')}
            </button>
            {canShare && (
              <button type="button" onClick={share} className="btn-secondary flex-1 justify-center gap-2" data-testid="invite-share">
                <Share size={16} aria-hidden="true" />
                {t('invites.share')}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-5 p-4">
          <div className="space-y-2">
            <p className="text-footnote text-text-secondary">{t('invites.role')}</p>
            <SegmentedControl
              ariaLabel={t('invites.role')}
              size="md"
              value={role}
              onChange={setRole}
              options={[
                { value: 'trainer', label: t('invites.roleTrainer') },
                { value: 'admin', label: t('invites.roleAdmin') },
              ]}
            />
            {role === 'admin' && <p className="text-footnote text-yellow">{t('invites.adminWarning')}</p>}
          </div>
          <div className="space-y-2">
            <p className="text-footnote text-text-secondary">{t('invites.expires')}</p>
            <SegmentedControl
              ariaLabel={t('invites.expires')}
              size="md"
              value={days}
              onChange={setDays}
              options={[
                { value: 1, label: t('invites.days1') },
                { value: 7, label: t('invites.days7') },
                { value: 30, label: t('invites.days30') },
              ]}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="invite-note" className="text-footnote text-text-secondary">{t('invites.note')}</label>
            <input
              id="invite-note"
              type="text"
              value={note}
              maxLength={200}
              onChange={event => setNote(event.target.value)}
              placeholder={t('invites.notePlaceholder')}
              className="input w-full"
            />
          </div>
        </div>
      )}
    </PageSheet>
  )
}

/**
 * Settings › Users & sign-in (admins, multi-user): invite someone, the invite list with status and
 * Revoke, and the audit log. Mounted by Settings.
 */
export default function InvitesSection() {
  const { t } = useSettings()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [revoking, setRevoking] = useState(null)

  const { data: invites = [], isError } = useQuery({ queryKey: ['invites'], queryFn: getInvites })

  const revokeMutation = useMutation({
    mutationFn: id => revokeInvite(id),
    onSuccess: () => {
      toast.success(t('invites.revokedToast'))
      queryClient.invalidateQueries({ queryKey: ['invites'] })
      queryClient.invalidateQueries({ queryKey: ['audit-log'] })
    },
    onError: error => toast.error(inviteErrorMessage(error, t('invites.revokeFailed'))),
  })

  const subtitle = invite => {
    const name = invite.created_by?.username || t('invites.someone')
    const parts = [t('invites.createdBy').replace('{name}', name)]
    if (invite.status === 'used') parts.push(t('invites.usedBy').replace('{name}', invite.used_by?.username || t('invites.someone')))
    else if (invite.status === 'revoked') parts.push(t('invites.revokedBy').replace('{name}', invite.revoked_by?.username || t('invites.someone')))
    else parts.push(t('invites.expiresOn').replace('{date}', formatDate(invite.expires_at)))
    return parts.join(' · ')
  }

  return (
    <section className="space-y-3" data-testid="invites-section">
      <ListSection header={t('invites.title')} footer={t('invites.footer')} className="!mx-0">
        <ListRow
          icon={UserPlus}
          iconColor="#30D158"
          title={t('invites.invite')}
          onClick={() => setCreating(true)}
          chevron
          testId="invite-create"
        />
        {isError && <p className="px-4 py-3 text-footnote text-red">{t('invites.loadFailed')}</p>}
        {!isError && invites.length === 0 && (
          <p className="px-4 py-3 text-footnote text-text-secondary">{t('invites.empty')}</p>
        )}
        {invites.map(invite => (
          <ListRow
            key={invite.id}
            testId={`invite-row-${invite.id}`}
            title={invite.note || (invite.role === 'admin' ? t('invites.roleAdmin') : t('invites.roleTrainer'))}
            subtitle={subtitle(invite)}
            trailing={<StatusChip status={invite.status} label={t(`invites.status.${invite.status}`)} />}
            onClick={invite.status === 'pending' ? () => setRevoking(invite) : undefined}
          />
        ))}
      </ListSection>

      <ListSection className="!mx-0">
        <ListRow
          icon={ClipboardList}
          iconColor="#8E8E93"
          title={t('audit.row')}
          subtitle={t('audit.rowDetail')}
          onClick={() => setAuditOpen(true)}
          chevron
          testId="audit-open"
        />
      </ListSection>

      <CreateInviteSheet isOpen={creating} onClose={() => setCreating(false)} />
      <AuditLogSheet isOpen={auditOpen} onClose={() => setAuditOpen(false)} />
      <ActionSheet
        isOpen={Boolean(revoking)}
        onClose={() => setRevoking(null)}
        title={t('invites.revoke')}
        message={t('invites.revokeMessage')}
        actions={[{ label: t('invites.revokeAction'), destructive: true, onSelect: () => revokeMutation.mutate(revoking.id) }]}
      />
    </section>
  )
}
