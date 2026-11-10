import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { CloudOff } from 'lucide-react'
import { addFeedReaction, getFeed, getFeedEvent, removeFeedReaction } from '../../api/client'
import Button from '../../components/ios/Button'
import PokeBall from '../../components/ios/PokeBall'
import { CardModal } from '../../components/CardItem'
import { useSettings } from '../../contexts/SettingsContext'
import { useOffline } from '../../offline/useOffline'
import { FEED_QUERY_KEY } from '../social'
import CommentsSheet from './CommentsSheet'
import FeedEventRow from './FeedEventRow'
import FeedIntroCard from './FeedIntroCard'
import SharingSheet from './SharingSheet'
import { INTRO_SEEN_KEY, feedState, groupByDay, isOn, toggleReaction } from './feedFormat'

const PAGE_SIZE = 20

/** Apply `change(item)` to one feed item in every cached page. */
function patchItem(queryClient, queryKey, eventId, change) {
  // The event a push opened, kept on its own when it is not in the loaded pages.
  queryClient.setQueryData([...FEED_QUERY_KEY, 'event', eventId], old => (old ? change(old) : old))
  queryClient.setQueryData(queryKey, (old) => {
    if (!old) return old
    return {
      ...old,
      pages: old.pages.map(page => ({
        ...page,
        items: page.items.map(item => (item.id === eventId ? change(item) : item)),
      })),
    }
  })
}

function EmptyState({ onShare }) {
  const { t } = useSettings()
  return (
    <section aria-labelledby="feed-empty-title" className="flex flex-col items-center px-4 pt-10 text-center" data-testid="feed-empty">
      <PokeBall size={56} />
      <h2 id="feed-empty-title" className="mt-4 text-title-3">{t('feed.emptyTitle')}</h2>
      <p className="mt-1.5 max-w-[300px] text-subheadline text-text-secondary">{t('feed.emptyText')}</p>
      <Button variant="gray" size="md" className="mt-5" onClick={onShare}>{t('feed.whatYouShare')}</Button>
    </section>
  )
}

function OfflineState() {
  const { t } = useSettings()
  return (
    <section className="flex flex-col items-center px-4 pt-10 text-center" data-testid="feed-offline">
      <span className="relative">
        <PokeBall size={56} top="var(--color-fill)" />
        <CloudOff size={18} aria-hidden="true" className="absolute -bottom-1 -right-1 rounded-full bg-bg p-0.5 text-text-secondary" />
      </span>
      <p className="mt-4 max-w-[300px] text-subheadline text-text-secondary">{t('feed.offline')}</p>
    </section>
  )
}

/** Leaderboard › Activity (docs/SOCIAL_DESIGN.md §6.2 to §6.5). */
export default function ActivityFeed() {
  const { t, settings, updateSettings, pricePrimaryField } = useSettings()
  const offline = useOffline()
  const queryClient = useQueryClient()
  const [sharingOpen, setSharingOpen] = useState(false)
  const [commentsFor, setCommentsFor] = useState(null)
  const [selectedCard, setSelectedCard] = useState(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const linkedId = Number.parseInt(searchParams.get('event') || '', 10) || null
  const linkedComments = searchParams.get('comments') === '1'
  const handledLink = useRef(null)
  const queryKey = useMemo(() => [...FEED_QUERY_KEY, pricePrimaryField], [pricePrimaryField])

  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: null,
    queryFn: ({ pageParam }) => getFeed({ limit: PAGE_SIZE, price_field: pricePrimaryField, ...(pageParam ? { before: pageParam } : {}) }),
    getNextPageParam: last => last?.next_before ?? undefined,
    refetchOnMount: 'always',
  })
  const items = useMemo(() => (query.data?.pages ?? []).flatMap(page => page.items), [query.data])
  // A reaction or comment push opens the feed at its event (?event=ID, plus &comments=1 for the comments sheet).
  // The event may be older than the loaded pages, so it is fetched on its own and pinned on top then.
  const linkedQuery = useQuery({
    queryKey: [...FEED_QUERY_KEY, 'event', linkedId],
    enabled: Boolean(linkedId),
    retry: false,
    queryFn: () => getFeedEvent(linkedId, { price_field: pricePrimaryField }),
  })
  const linkedItem = linkedId ? (items.find(item => item.id === linkedId) ?? linkedQuery.data ?? null) : null
  const pinned = linkedItem && !items.some(item => item.id === linkedItem.id) ? linkedItem : null
  useEffect(() => {
    if (!linkedId || handledLink.current === linkedId) return
    if (linkedQuery.isError && !linkedItem) {
      // Gone, or no longer shared: just the feed.
      handledLink.current = linkedId
      setSearchParams({}, { replace: true })
      return
    }
    if (!linkedItem) return
    handledLink.current = linkedId
    if (linkedComments) setCommentsFor(linkedItem)
    setSearchParams({}, { replace: true })
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-event-id="${linkedId}"]`)?.scrollIntoView?.({ block: 'center' })
    })
  }, [linkedId, linkedItem, linkedComments, linkedQuery.isError, setSearchParams])
  // A request that got no answer at all means the server can't be reached, banner or not.
  const unreachable = query.isError && !query.error?.response
  const state = feedState({ offline: offline || unreachable, isLoading: query.isLoading, error: query.error, itemCount: items.length })
  const groups = useMemo(() => groupByDay(items, t, new Date(), document.documentElement.lang || undefined), [items, t])

  // Loads the next page when the end of the list scrolls near.
  const sentinel = useRef(null)
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query
  useEffect(() => {
    const node = sentinel.current
    if (!node || !hasNextPage || isFetchingNextPage || isFetchNextPageError || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) fetchNextPage()
    }, { rootMargin: '400px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, items.length])

  const react = async (item, kind) => {
    const before = item.reactions
    const reacting = !(before?.mine ?? []).includes(kind)
    patchItem(queryClient, queryKey, item.id, row => ({ ...row, reactions: toggleReaction(row.reactions, kind) }))
    try {
      const answer = await (reacting ? addFeedReaction(item.id, kind) : removeFeedReaction(item.id, kind))
      patchItem(queryClient, queryKey, item.id, row => ({ ...row, reactions: answer }))
    } catch {
      patchItem(queryClient, queryKey, item.id, row => ({ ...row, reactions: before }))
      toast.error(t('feed.reactionFailed'))
    }
  }

  const setCount = (eventId, count) => {
    patchItem(queryClient, queryKey, eventId, row => ({ ...row, comment_count: count }))
  }

  const introSeen = isOn(settings, INTRO_SEEN_KEY, false)
  const dismissIntro = () => { updateSettings({ [INTRO_SEEN_KEY]: 'true' }).catch(() => {}) }

  return (
    <div className="flex flex-col gap-3" data-testid="activity-feed">
      {!introSeen && state !== 'offline' && (
        <FeedIntroCard onChange={() => setSharingOpen(true)} onDismiss={dismissIntro} />
      )}

      {state === 'offline' && <OfflineState />}
      {state === 'loading' && (
        <div className="space-y-3">{[0, 1, 2].map(i => <div key={i} className="skeleton h-40 rounded-xl" />)}</div>
      )}
      {state === 'error' && (
        <div className="card text-sm text-red" role="alert">
          <p>{t('feed.loadFailed')}</p>
          <Button variant="gray" size="sm" className="mt-3" onClick={() => query.refetch()}>{t('feed.retry')}</Button>
        </div>
      )}
      {pinned && (
        <div data-event-id={pinned.id} className="scroll-mt-4">
          <FeedEventRow
            item={pinned}
            reactionsDisabled={offline}
            onReact={react}
            onOpenCard={setSelectedCard}
            onOpenComments={setCommentsFor}
          />
        </div>
      )}
      {state === 'empty' && !pinned && <EmptyState onShare={() => setSharingOpen(true)} />}

      {state === 'list' && groups.map((group, index) => (
        <Fragment key={`${group.label}-${group.items[0].id}`}>
          {index === 0 ? (
            <div className="-mb-2 flex items-center justify-between">
              <h2 className="px-1 text-footnote text-text-secondary">{group.label}</h2>
              <button
                type="button"
                onClick={() => setSharingOpen(true)}
                className="ios-press inline-flex min-h-[44px] items-center px-1 text-footnote font-semibold text-tint"
              >
                {t('feed.whatYouShare')}
              </button>
            </div>
          ) : (
            <h2 className="mt-1 px-1 text-footnote text-text-secondary">{group.label}</h2>
          )}
          {group.items.map(item => (
            <div key={item.id} data-event-id={item.id} className="scroll-mt-4">
              <FeedEventRow
                item={item}
                reactionsDisabled={offline}
                onReact={react}
                onOpenCard={setSelectedCard}
                onOpenComments={setCommentsFor}
              />
            </div>
          ))}
        </Fragment>
      ))}

      {state === 'list' && hasNextPage && (
        <div ref={sentinel} className="flex min-h-[44px] items-center justify-center">
          {isFetchNextPageError ? (
            <Button variant="gray" size="md" onClick={() => fetchNextPage()}>{t('feed.more')}</Button>
          ) : (
            <div className="skeleton h-40 w-full rounded-xl" aria-hidden="true" />
          )}
        </div>
      )}

      <SharingSheet
        isOpen={sharingOpen}
        onClose={() => { setSharingOpen(false); queryClient.invalidateQueries({ queryKey: FEED_QUERY_KEY }) }}
      />
      <CommentsSheet event={commentsFor} onClose={() => setCommentsFor(null)} onCount={setCount} />
      {selectedCard && (
        <CardModal card={{ ...selectedCard, id: selectedCard.card_id || selectedCard.id }} onClose={() => setSelectedCard(null)} />
      )}
    </div>
  )
}
