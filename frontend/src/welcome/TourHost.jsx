import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { PlusSquare, Share } from 'lucide-react'
import Alert from '../components/ios/Alert'
import Button from '../components/ios/Button'
import PokeBall from '../components/ios/PokeBall'
import { isIosDevice } from '../components/pwa/InstallHint'
import { getBinders, getGoals } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useScanner } from '../contexts/ScannerContext'
import { useSettings } from '../contexts/SettingsContext'
import { isStandalone } from '../offline/capabilities'
import { useOffline } from '../offline/useOffline'
import { readPwaFlags } from '../pwa/flags'
import { useSocialEnabled } from '../social/social'
import CenterCard from './CenterCard'
import { promptInstall, useInstallable } from './installPrompt'
import TourSpotlight from './TourSpotlight'
import { TOUR_START_EVENT, setHomeNote } from './tourControl'
import { setTourActive } from './tourBus'
import { homeScreenStepKind, tourSteps } from './tourSteps'
import { isNewAccount, recordTourDone, syncTourDone, tourIsDone } from './tourStorage'

const AUTO_START_DELAY_MS = 600
const GUARD_DELAY_MS = 900
// An app session starts the tour by itself once: leaving it part-way (to add the Home Screen app, say) must not bring it back at once.
const autoStarted = new Set()

function HomeScreenCard({ kind, onSkip, onAdd, onCarryOn, onInstall }) {
  const { t } = useSettings()
  const install = kind === 'install'
  return (
    <CenterCard label={t('tour.dialogLabel')}>
      {titleId => (
        <>
          <div className="-mr-2 -mt-3 flex justify-end">
            <button type="button" onClick={onSkip} className="ios-press min-h-[44px] min-w-[44px] px-1 text-right text-callout text-tint">
              {t('tour.skip')}
            </button>
          </div>
          <div className="-mt-2 flex flex-col items-center text-center">
            <span
              aria-hidden="true"
              className="grid h-14 w-14 place-items-center rounded-[16px] text-white"
              style={{ background: 'linear-gradient(150deg, var(--type-water-top), var(--type-water-bottom))' }}
            >
              <PlusSquare size={28} />
            </span>
            <h2 id={titleId} className="mt-3 text-title-2 font-display">{t(install ? 'tour.installTitle' : 'tour.homeScreenTitle')}</h2>
            <p className="mt-2 text-callout text-text-secondary">{t(install ? 'tour.installBody' : 'tour.homeScreenBody')}</p>
          </div>
          {!install && (
            <ol className="mt-3 flex flex-col gap-0.5">
              {[1, 2, 3].map(n => (
                <li key={n} className="flex min-h-[44px] items-center gap-3">
                  <span aria-hidden="true" className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full bg-fill-tertiary text-subheadline font-semibold">{n}</span>
                  <span className="flex-1 text-callout">
                    {t(`tour.hsStep${n}Pre`)}<strong>{t(`tour.hsStep${n}Bold`)}</strong>
                    {n === 1 && <> <Share size={16} className="inline text-tint" aria-hidden="true" /></>}
                    {t(`tour.hsStep${n}Post`)}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <div className="mt-4 flex flex-col gap-1">
            <Button size="lg" full onClick={install ? onInstall : onAdd}>{t(install ? 'tour.install' : 'tour.addNow')}</Button>
            <Button variant="gray" full onClick={onCarryOn}>{t('tour.carryOnBrowser')}</Button>
          </div>
        </>
      )}
    </CenterCard>
  )
}

function BallCard({ title, body, note, primary, onPrimary, secondary, onSecondary, label }) {
  return (
    <CenterCard label={label}>
      {titleId => (
        <>
          <div className="flex flex-col items-center text-center">
            <PokeBall size={72} />
            <h2 id={titleId} className="mt-4 text-title-2 font-display">{title}</h2>
            <p className="mt-2 text-callout text-text-secondary">{body}</p>
            {note && <p className="mt-2 text-callout text-text-secondary">{note}</p>}
          </div>
          <div className="mt-6 flex flex-col gap-1">
            <Button size="lg" full onClick={onPrimary}>{primary}</Button>
            <Button variant="plain" full onClick={onSecondary}>{secondary}</Button>
          </div>
        </>
      )}
    </CenterCard>
  )
}

/**
 * The hands-on tour (docs/WELCOME_DESIGN.md §3). Mounted once in App.jsx under the router. It starts by itself for a new
 * account's first Home visit, or when asked (the Take the tour card, Settings › About), and walks the trainer through
 * the real app one control at a time. Part-way state lives in memory only; only Finish, a confirmed Skip or
 * "Not now" is written down (tourStorage).
 */
export default function TourHost() {
  const { user, multiUser, updateCurrentUser } = useAuth()
  const { t } = useSettings()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { openScanner } = useScanner()
  const social = useSocialEnabled()
  const offline = useOffline()
  const installable = useInstallable()

  const [phase, setPhase] = useState(null) // null | 'welcome' | 'homescreen' | 'steps' | 'end'
  const [stepId, setStepId] = useState(null)
  const [alert, setAlert] = useState(null) // null | 'skip' | 'sure1' | 'sure2'
  const [empty, setEmpty] = useState({})
  const guardedFor = useRef(null)

  const standalone = isStandalone()
  const flags = readPwaFlags()
  const steps = useMemo(
    () => tourSteps({ social, standalone, flags, empty }),
    [social, standalone, flags.queue, empty], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const index = steps.findIndex(item => item.id === stepId)
  const step = index >= 0 ? steps[index] : null
  const hsKind = homeScreenStepKind({ standalone, ios: isIosDevice(), installable })
  const eligible = Boolean(user) && multiUser === true

  const userRef = useRef(user)
  userRef.current = user

  useEffect(() => {
    setTourActive(phase !== null)
    return () => setTourActive(false)
  }, [phase])

  // A completion that could not be sent (offline) goes out at the next start and when the device is back online.
  useEffect(() => {
    if (!eligible || offline) return
    syncTourDone(user, updateCurrentUser)
  }, [eligible, offline, user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const begin = useCallback(() => {
    setAlert(null)
    setStepId(null)
    setPhase('welcome')
    // Nothing to point at on a new account's empty screens: ask once, up front (docs §3.6).
    Promise.allSettled([getBinders(), getGoals()]).then(([binders, goals]) => {
      setEmpty({
        binders: binders.status === 'fulfilled' && Array.isArray(binders.value?.data) && binders.value.data.length === 0,
        goals: goals.status === 'fulfilled' && Array.isArray(goals.value) && goals.value.length === 0,
      })
    })
  }, [])

  // Started by hand.
  useEffect(() => {
    if (!eligible) return undefined
    const onStart = () => {
      autoStarted.add(userRef.current.id)
      begin()
    }
    window.addEventListener(TOUR_START_EVENT, onStart)
    return () => window.removeEventListener(TOUR_START_EVENT, onStart)
  }, [eligible, begin])

  // Started by itself: a new account, on its first Home visit.
  useEffect(() => {
    if (!eligible || phase !== null || pathname !== '/') return undefined
    if (autoStarted.has(user.id) || tourIsDone(user) || !isNewAccount(user)) return undefined
    const timer = window.setTimeout(() => {
      autoStarted.add(user.id)
      begin()
    }, AUTO_START_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [eligible, phase, pathname, user, begin])

  const finishWith = useCallback((outcome) => {
    if (userRef.current) recordTourDone(userRef.current, outcome, updateCurrentUser)
    setAlert(null)
    setPhase(null)
    setStepId(null)
  }, [updateCurrentUser])

  const leaveForHomeScreen = useCallback(() => {
    // Part-way: nothing is written, so the tour starts again from the welcome in the Home Screen app.
    setHomeNote(true)
    setAlert(null)
    setPhase(null)
    setStepId(null)
  }, [])

  const goToSteps = useCallback(() => {
    setAlert(null)
    setStepId(tourSteps({ social, standalone, flags, empty })[0].id)
    setPhase('steps')
  }, [social, standalone, flags.queue, empty]) // eslint-disable-line react-hooks/exhaustive-deps

  const start = useCallback(() => {
    if (hsKind) setPhase('homescreen')
    else goToSteps()
  }, [hsKind, goToSteps])

  const advance = useCallback(() => {
    const next = steps[index + 1]
    if (!next) {
      if (user) recordTourDone(user, 'finished', updateCurrentUser)
      setPhase('end')
      setStepId(null)
      return
    }
    setStepId(next.id)
  }, [steps, index, user, updateCurrentUser])

  const onNext = useCallback(() => {
    const next = steps[index + 1]
    // The next step lives on another screen (the last goals step goes back to Profile): take the trainer there.
    if (next?.route && !next.route.test(pathname) && next.go) navigate(next.go)
    advance()
  }, [steps, index, pathname, navigate, advance])

  const onMissing = useCallback((missing) => {
    if (missing.id === steps[index]?.id) advance()
  }, [steps, index, advance])

  // The route guard (§3.5): a trainer who wandered off the path is brought back once, or the section is skipped.
  useEffect(() => {
    if (phase !== 'steps' || !step?.route) return undefined
    const next = steps[index + 1]
    if (step.route.test(pathname) || next?.route?.test(pathname)) return undefined
    const timer = window.setTimeout(() => {
      if (guardedFor.current === step.id) return
      guardedFor.current = step.id
      if (step.go) navigate(step.go, { replace: true })
      else {
        const sameSection = steps.findIndex((item, i) => i > index && item.section !== step.section)
        if (sameSection >= 0) setStepId(steps[sameSection].id)
        else advance()
      }
    }, GUARD_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [phase, step, steps, index, pathname, navigate, advance])

  // Escape opens the Skip alert (iPad with a keyboard).
  useEffect(() => {
    if (phase === null || alert) return undefined
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setAlert('skip')
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [phase, alert])

  if (!eligible || phase === null) return null

  const copy = step ? t(`tour.steps.${step.copy}.title`) : ''
  const stepKey = step ? `tour.steps.${step.copy}` : ''
  const tapKey = `${stepKey}.tap`
  const finishStep = Boolean(step?.finish)
  const skipOpen = () => setAlert('skip')

  const alerts = (
    <>
      <Alert
        isOpen={alert === 'skip'}
        onClose={() => setAlert(null)}
        title={t('tour.skipAlertTitle')}
        message={t('tour.skipAlertMessage')}
        zIndex={70}
        stacked
        actions={[
          { label: t('tour.keepGoing'), preferred: true, onSelect: () => setAlert(null) },
          { label: t('tour.skip'), onSelect: () => finishWith('skipped') },
        ]}
      />
      <Alert
        isOpen={alert === 'sure1'}
        onClose={() => setAlert(null)}
        title={t('tour.sureTitle')}
        message={t('tour.sureMessage')}
        zIndex={70}
        stacked
        actions={[
          { label: t('tour.addFirst'), preferred: true, onSelect: () => setAlert(null) },
          { label: t('tour.carryOnBrowser'), onSelect: () => setAlert('sure2') },
        ]}
      />
      <Alert
        isOpen={alert === 'sure2'}
        onClose={() => setAlert(null)}
        title={t('tour.reallyTitle')}
        message={t('tour.reallyMessage')}
        zIndex={70}
        stacked
        actions={[
          { label: t('tour.addFirst'), preferred: true, onSelect: () => setAlert(null) },
          { label: t('tour.yesCarryOn'), onSelect: goToSteps },
        ]}
      />
    </>
  )

  return (
    <>
      {phase === 'welcome' && (
        <BallCard
          label={t('tour.dialogLabel')}
          title={t('tour.welcomeTitle').replace('{name}', user.username)}
          body={t('tour.welcomeBody')}
          primary={t('tour.start')}
          onPrimary={start}
          secondary={t('tour.skipTour')}
          onSecondary={skipOpen}
        />
      )}
      {phase === 'homescreen' && (
        <HomeScreenCard
          kind={hsKind ?? 'ios'}
          onSkip={skipOpen}
          onAdd={leaveForHomeScreen}
          onCarryOn={() => setAlert('sure1')}
          onInstall={async () => {
            if (await promptInstall()) leaveForHomeScreen()
          }}
        />
      )}
      {phase === 'steps' && step && (
        <TourSpotlight
          key={step.id}
          step={step}
          title={copy}
          body={t(`${stepKey}.body`)}
          tap={step.kind === 'tap' ? t(tapKey) : null}
          finish={finishStep}
          onTap={advance}
          onNext={onNext}
          onSkip={skipOpen}
          onMissing={onMissing}
        />
      )}
      {phase === 'end' && (
        <BallCard
          label={t('tour.dialogLabel')}
          title={t('tour.endTitle')}
          body={t('tour.endBody')}
          note={flags.queue ? null : t('tour.endOffline')}
          primary={t('tour.endScan')}
          onPrimary={() => {
            setPhase(null)
            openScanner()
          }}
          secondary={t('tour.endExplore')}
          onSecondary={() => setPhase(null)}
        />
      )}
      {alerts}
    </>
  )
}
