import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Check } from 'lucide-react'
import { getUnseenUnlocks, markUnlocksSeen } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import BadgeMedal from '../components/ios/BadgeMedal'
import PageSheet from '../components/ios/PageSheet'
import { fill } from '../components/splash/format'
import { isBusy, mergeQueue, tierLabelKey, unseenItems } from './achievements'

const RETRY_MS = 2000

function BadgeSheet({ item, more, t }) {
  const name = t(item.name_key)
  return (
    <div data-unlock-sheet data-testid="unlock-sheet" data-achievement-id={item.id} className="flex flex-col items-center gap-3 px-6 pb-6 pt-8 text-center">
      <BadgeMedal track={item.track} tier={item.tier} holo size={132} label={name} />
      <p className="text-footnote font-semibold uppercase tracking-wide text-text-secondary">{t(tierLabelKey(item.tier))}</p>
      <h3 className="break-words text-title-2 font-display text-text-primary">{name}</h3>
      <p className="break-words text-body text-text-secondary">{t(item.description_key)}</p>
      {more > 0 && (
        <p className="text-footnote text-text-secondary" data-testid="unlock-more">
          {t('achievements.unlockMore').replace('{count}', more)}
        </p>
      )}
    </div>
  )
}

function QuestSheet({ item, more, t }) {
  const name = t(`today.quest.${item.quest_id}`)
  return (
    <div data-unlock-sheet data-testid="quest-sheet" data-quest-id={item.quest_id} className="flex flex-col items-center gap-3 px-6 pb-6 pt-8 text-center">
      <span className="grid h-24 w-24 place-items-center rounded-full bg-green text-on-accent" aria-hidden="true">
        <Check size={52} strokeWidth={3} />
      </span>
      <p className="text-footnote font-semibold uppercase tracking-wide text-text-secondary">{t('today.questComplete')}</p>
      <h3 className="break-words text-title-2 font-display text-text-primary" data-testid="quest-sheet-name">{name}</h3>
      <p className="rounded-full bg-fill-tertiary px-4 py-1.5 text-headline tabular-nums text-text-primary" data-testid="quest-sheet-xp">
        {fill(t('today.questXp'), { xp: item.xp })}
      </p>
      {item.bonus_xp > 0 && (
        <p className="break-words text-subheadline text-text-secondary" data-testid="quest-sheet-bonus">
          {fill(t('today.questBonus'), { xp: item.bonus_xp })}
        </p>
      )}
      {more > 0 && (
        <p className="text-footnote text-text-secondary" data-testid="unlock-more">
          {t('achievements.unlockMore').replace('{count}', more)}
        </p>
      )}
    </div>
  )
}

/**
 * The one-shot celebration sheet (engagement P6, P7). It asks the server for badges earned and daily
 * quests completed but not yet celebrated when the app opens, when it returns to the foreground,
 * when the screen changes and when the Today card refreshes. It shows them one after another, badges
 * and quests in the one queue so they never overlap, waits while a scan or another sheet is open, and
 * marks each seen when the trainer dismisses it.
 */
export default function UnlockSheetHost() {
  const { user } = useAuth()
  const { t } = useSettings()
  const { pathname } = useLocation()
  const queryClient = useQueryClient()
  const userId = user?.id
  const [queue, setQueue] = useState([])
  const [busy, setBusy] = useState(false)
  const handled = useRef(new Set())

  const load = useCallback(async () => {
    if (typeof userId !== 'number' || globalThis.navigator?.onLine === false) return
    try {
      const response = await getUnseenUnlocks()
      setQueue(current => mergeQueue(current, unseenItems(response.data), handled.current))
    } catch {
      // silent: the sheet is a bonus, never an error
    }
  }, [userId])

  useEffect(() => {
    handled.current = new Set()
    setQueue([])
    load()
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  // A quest is awarded when the server builds the Today summary, so look again after each one.
  useEffect(() => queryClient.getQueryCache().subscribe((event) => {
    if (event?.type === 'updated' && event.action?.type === 'success' && event.query?.queryKey?.[0] === 'today-card') load()
  }), [queryClient, load])

  useEffect(() => { load() }, [pathname, load])

  // Re-check whether something is in the way while there is something to show.
  const waiting = queue.length > 0
  useEffect(() => {
    if (!waiting) return undefined
    const check = () => setBusy(isBusy(document, pathname))
    check()
    const timer = setInterval(check, RETRY_MS)
    return () => clearInterval(timer)
  }, [waiting, pathname])

  const current = waiting && !busy ? queue[0] : null

  const dismiss = () => {
    if (!current) return
    handled.current.add(current.id)
    setQueue(items => items.filter(item => item.id !== current.id))
    const request = current.kind === 'quest' ? markUnlocksSeen(undefined, [current.key]) : markUnlocksSeen([current.id])
    request.catch(() => {})
  }

  if (!current) return null
  const more = queue.length - 1
  const isQuest = current.kind === 'quest'
  const nextLabel = queue[1]?.kind === 'quest' ? t('today.questNext') : t('achievements.unlockNext')
  return (
    <PageSheet
      isOpen
      onClose={dismiss}
      title={t(isQuest ? 'today.questCompleteTitle' : 'achievements.unlockedTitle')}
      leading={<span />}
      trailing={{ label: more > 0 ? nextLabel : t('achievements.unlockDone'), onPress: dismiss }}
    >
      {isQuest ? <QuestSheet item={current} more={more} t={t} /> : <BadgeSheet item={current} more={more} t={t} />}
    </PageSheet>
  )
}
