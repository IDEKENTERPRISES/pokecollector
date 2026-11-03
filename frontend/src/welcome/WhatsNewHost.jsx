import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { setWhatsNewSeen } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import WhatsNewSheet from './WhatsNewSheet'
import { current, planWhatsNew } from './releases'
import { isNonprod } from './channel'
import { readLocalSeen, writeLocalSeen } from './seen'
import { takeTestOverride } from './testOverride'
import { useTourActive } from './tourBus'

/**
 * Opens the What's new sheet once per update (docs/WELCOME_DESIGN.md §5.2, §5.5). It decides once per
 * signed-in account, waits while a tour is showing, and counts every way of closing as "seen": the
 * running release id goes to this device at once and to the server when it can. A failed server write
 * is retried at the next start, because this device's copy is then ahead of the server's.
 */
export default function WhatsNewHost() {
  const { user, updateCurrentUser } = useAuth()
  const tourActive = useTourActive()
  const navigate = useNavigate()
  const [missed, setMissed] = useState(null)
  const decidedFor = useRef(null)

  const userId = user?.id
  const hasField = Boolean(user) && 'whats_new_seen' in user
  const serverSeen = user?.whats_new_seen ?? null

  const save = useCallback((id) => {
    if (userId == null) return
    writeLocalSeen(userId, id)
    setWhatsNewSeen(id)
      .then(() => updateCurrentUser?.({ whats_new_seen: id }))
      .catch(() => {})
  }, [userId, updateCurrentUser])

  useEffect(() => {
    // A user object saved by an older build has no field yet; wait for the fresh one.
    if (userId == null || !hasField || decidedFor.current === userId) return
    decidedFor.current = userId
    const running = current()?.id
    // Nonprod only: a "Test What's new" choice stands in for both seen values, once.
    const override = (import.meta.env.DEV || __RELEASE_CHANNEL__ === 'nonprod') && isNonprod() ? takeTestOverride(userId) : null
    const plan = override
      ? planWhatsNew({ serverSeen: override, localSeen: override })
      : planWhatsNew({ serverSeen, localSeen: readLocalSeen(userId) })
    if (plan.action === 'show') setMissed(plan.missed)
    else if ((plan.action === 'init' || plan.action === 'sync') && running) save(running)
  }, [userId, hasField, serverSeen, save])

  if (!missed) return null

  const close = () => {
    setMissed(null)
    save(current().id)
  }
  const seeAll = () => {
    close()
    navigate('/settings/about/versions')
  }

  return <WhatsNewSheet isOpen={!tourActive} onClose={close} onSeeAll={seeAll} releases={missed} />
}
