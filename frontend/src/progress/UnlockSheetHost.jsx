import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { getUnseenUnlocks, markUnlocksSeen } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useSettings } from '../contexts/SettingsContext'
import BadgeMedal from '../components/ios/BadgeMedal'
import PageSheet from '../components/ios/PageSheet'
import { isBusy, mergeQueue, tierLabelKey } from './achievements'

const RETRY_MS = 2000

/**
 * The one-shot unlock sheet (engagement P6). It asks the server for badges not yet celebrated when
 * the app opens and when it returns to the foreground, then shows them one after another. It waits
 * while a scan or another sheet is open, and marks each badge seen when the trainer dismisses it.
 */
export default function UnlockSheetHost() {
  const { user } = useAuth()
  const { t } = useSettings()
  const { pathname } = useLocation()
  const userId = user?.id
  const [queue, setQueue] = useState([])
  const [busy, setBusy] = useState(false)
  const handled = useRef(new Set())

  const load = useCallback(async () => {
    if (typeof userId !== 'number' || globalThis.navigator?.onLine === false) return
    try {
      const response = await getUnseenUnlocks()
      setQueue(current => mergeQueue(current, response.data?.unlocks, handled.current))
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
    markUnlocksSeen([current.id]).catch(() => {})
  }

  if (!current) return null
  const name = t(current.name_key)
  const more = queue.length - 1
  return (
    <PageSheet
      isOpen
      onClose={dismiss}
      title={t('achievements.unlockedTitle')}
      leading={<span />}
      trailing={{ label: more > 0 ? t('achievements.unlockNext') : t('achievements.unlockDone'), onPress: dismiss }}
    >
      <div data-unlock-sheet data-testid="unlock-sheet" data-achievement-id={current.id} className="flex flex-col items-center gap-3 px-6 pb-6 pt-8 text-center">
        <BadgeMedal track={current.track} tier={current.tier} holo size={132} label={name} />
        <p className="text-footnote font-semibold uppercase tracking-wide text-text-secondary">{t(tierLabelKey(current.tier))}</p>
        <h3 className="break-words text-title-2 font-display text-text-primary">{name}</h3>
        <p className="break-words text-body text-text-secondary">{t(current.description_key)}</p>
        {more > 0 && (
          <p className="text-footnote text-text-secondary" data-testid="unlock-more">
            {t('achievements.unlockMore').replace('{count}', more)}
          </p>
        )}
      </div>
    </PageSheet>
  )
}
