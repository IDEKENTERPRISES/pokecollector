import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUp, MessageCircle, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { addFeedComment, deleteFeedComment, getFeedComments } from '../../api/client'
import Alert from '../../components/ios/Alert'
import IconButton from '../../components/ios/IconButton'
import PageSheet from '../../components/ios/PageSheet'
import { useSettings } from '../../contexts/SettingsContext'
import { useOffline } from '../../offline/useOffline'
import { TrainerAvatar } from '../../pages/socialParts'
import { COMMENT_MAX_LENGTH, ageLabel, cleanComment } from './feedFormat'

/**
 * The comments under one event (docs/SOCIAL_DESIGN.md D6): a list in the feed's card style, oldest
 * first, and a composer in the sheet's footer. Plain text, up to 280 characters. The author and the
 * event's owner can delete a comment. No pushes and no badge numbers: comments are read here.
 * `onCount(eventId, count)` keeps the feed row's count in step.
 */
export default function CommentsSheet({ event, onClose, onCount }) {
  const { t } = useSettings()
  const offline = useOffline()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const [deleting, setDeleting] = useState(null)
  const eventId = event?.id
  const queryKey = ['feed', 'comments', eventId]

  const { data, isLoading, error } = useQuery({
    queryKey,
    enabled: Boolean(eventId),
    queryFn: () => getFeedComments(eventId),
  })
  const items = data?.items ?? []

  const send = useMutation({
    mutationFn: text => addFeedComment(eventId, text),
    onSuccess: (result) => {
      setDraft('')
      queryClient.setQueryData(queryKey, old => ({ items: [...(old?.items ?? []), result.comment] }))
      onCount?.(eventId, result.comment_count)
    },
    onError: error => toast.error(error?.response?.data?.detail || t('feed.commentSendFailed')),
  })
  const remove = useMutation({
    mutationFn: comment => deleteFeedComment(eventId, comment.id),
    onSuccess: (result, comment) => {
      setDeleting(null)
      queryClient.setQueryData(queryKey, old => ({ items: (old?.items ?? []).filter(item => item.id !== comment.id) }))
      onCount?.(eventId, result.comment_count)
    },
    onError: () => { setDeleting(null); toast.error(t('feed.commentDeleteFailed')) },
  })

  const cleaned = cleanComment(draft)
  const canSend = Boolean(cleaned) && !offline && !send.isPending
  const submit = (e) => {
    e.preventDefault()
    if (canSend) send.mutate(cleaned)
  }
  const nearLimit = draft.length >= COMMENT_MAX_LENGTH - 40

  const footer = (
    <form onSubmit={submit} className="flex items-end gap-2">
      <div className="min-w-0 flex-1">
        <label htmlFor="feed-comment-input" className="sr-only">{t('feed.commentPlaceholder')}</label>
        <textarea
          id="feed-comment-input"
          rows={1}
          value={draft}
          maxLength={COMMENT_MAX_LENGTH}
          onChange={e => setDraft(e.target.value)}
          placeholder={t('feed.commentPlaceholder')}
          enterKeyHint="send"
          className="block max-h-28 min-h-[44px] w-full resize-none rounded-[22px] bg-fill-tertiary px-4 py-[11px] text-body text-text-primary placeholder:text-text-tertiary focus:outline-2 focus:outline-tint"
        />
        {nearLimit && (
          <p className="mt-1 px-4 text-caption-1 tabular-nums text-text-secondary" aria-live="polite">
            {t('feed.commentCounter').replace('{count}', draft.length).replace('{max}', COMMENT_MAX_LENGTH)}
          </p>
        )}
        {offline && <p className="mt-1 px-4 text-caption-1 text-text-secondary">{t('feed.commentNeedsConnection')}</p>}
      </div>
      <button
        type="submit"
        disabled={!canSend}
        aria-label={t('feed.commentSend')}
        className="ios-press grid h-11 w-11 flex-shrink-0 place-items-center rounded-full bg-accent text-on-accent disabled:opacity-40"
      >
        <ArrowUp size={20} strokeWidth={2.5} aria-hidden="true" />
      </button>
    </form>
  )

  return (
    <PageSheet
      isOpen={Boolean(event)}
      onClose={onClose}
      title={t('feed.comments')}
      leading={<span />}
      trailing={{ label: t('feed.commentsDone'), onPress: onClose }}
      footer={footer}
    >
      <div className="min-h-[200px] px-4 pb-4 pt-4" data-testid="feed-comments-list">
        {isLoading ? (
          <div className="space-y-3">{[0, 1].map(i => <div key={i} className="skeleton h-16 rounded-xl" />)}</div>
        ) : error ? (
          <p role="alert" className="rounded-xl bg-card p-4 text-subheadline text-red">
            {error?.response?.status === 404 ? t('feed.commentsHidden') : t('feed.commentsLoadFailed')}
          </p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center px-4 pt-10 text-center">
            <MessageCircle size={40} strokeWidth={1.5} aria-hidden="true" className="text-text-muted" />
            <h3 className="mt-4 text-title-3">{t('feed.commentsEmptyTitle')}</h3>
            <p className="mt-1.5 max-w-[300px] text-subheadline text-text-secondary">{t('feed.commentsEmptyText')}</p>
          </div>
        ) : (
          <ul className="overflow-hidden rounded-xl bg-card">
            {items.map(comment => {
              const age = ageLabel(comment.created_at, t)
              return (
                <li
                  key={comment.id}
                  className="relative flex items-start gap-3 px-4 py-3 after:absolute after:bottom-0 after:left-[60px] after:right-0 after:h-[0.5px] after:bg-border last:after:hidden"
                  data-testid="feed-comment"
                >
                  <TrainerAvatar avatarId={comment.author?.avatar_id} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="text-subheadline">
                      <span className="font-semibold">{comment.mine ? t('feed.you') : comment.author?.username}</span>
                      <span className="text-caption-1 text-text-secondary"> · {age}</span>
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-subheadline">{comment.text}</p>
                  </div>
                  {comment.can_delete && (
                    <IconButton
                      icon={Trash2}
                      label={t('feed.commentDelete')}
                      variant="gray"
                      size="sm"
                      disabled={offline}
                      onClick={() => setDeleting(comment)}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      <Alert
        isOpen={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title={t('feed.commentDeleteTitle')}
        actions={[
          { label: t('feed.commentDeleteCancel'), style: 'cancel', onSelect: () => setDeleting(null) },
          { label: t('feed.commentDeleteConfirm'), style: 'destructive', preferred: true, onSelect: () => remove.mutate(deleting) },
        ]}
      />
    </PageSheet>
  )
}
