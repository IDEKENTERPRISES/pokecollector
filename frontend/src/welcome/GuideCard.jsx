import { forwardRef, useId, useState } from 'react'
import { Bell, Camera, Check, Cloud, Layers, Pointer } from 'lucide-react'
import clsx from 'clsx'
import Button from '../components/ios/Button'
import { useSettings } from '../contexts/SettingsContext'
import { useOffline } from '../offline/useOffline'
import { enablePush, pushPermission, pushSupported } from '../pwa/push'
import { TOUR_SECTIONS } from './tourSteps'

function Note({ icon: Icon, children, status = false }) {
  return (
    <p className="mt-2.5 flex gap-2 text-footnote text-text-secondary" role={status ? 'status' : undefined}>
      <Icon size={16} className="mt-px flex-shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

/**
 * The notifications ask in the scan-queue step (docs/WELCOME_DESIGN.md §3.7). The Home Screen app gets a button that
 * runs enablePush(); the browser gets a plain sentence. Declining leaves a sentence and the tour carries on.
 */
function NotificationsAsk({ browser }) {
  const { t } = useSettings()
  const offline = useOffline()
  const [state, setState] = useState(() => (pushPermission() === 'granted' ? 'on' : 'idle'))
  if (browser) return <Note icon={Bell}>{t('tour.askBrowser')}</Note>
  if (state === 'on') return <Note icon={Check} status>{t('tour.askOn')}</Note>
  if (state === 'declined') return <Note icon={Bell} status>{t('tour.askDeclined')}</Note>
  if (!pushSupported()) return null
  if (offline) return <Note icon={Bell}>{t('tour.askOffline')}</Note>
  const turnOn = async () => {
    setState('asking')
    const result = await enablePush()
    setState(result.ok ? 'on' : 'declined')
  }
  return (
    <>
      <p className="mt-2.5 text-callout text-text-primary">{t('tour.askLead')}</p>
      <Button variant="tinted" full icon={Bell} loading={state === 'asking'} onClick={turnOn} className="mt-2.5">
        {t('tour.askButton')}
      </Button>
    </>
  )
}

function OfflineBody() {
  const { t } = useSettings()
  const rows = [
    { Icon: Layers, bold: 'tour.steps.offlineCard.browseBold', text: 'tour.steps.offlineCard.browse' },
    { Icon: Camera, bold: 'tour.steps.offlineCard.scanBold', text: 'tour.steps.offlineCard.scan' },
    { Icon: Cloud, bold: 'tour.steps.offlineCard.changesBold', text: 'tour.steps.offlineCard.changes' },
  ]
  return (
    <>
      <ul className="mt-0.5">
        {rows.map(({ Icon, bold, text }) => (
          <li key={bold} className="flex items-start gap-3 py-[5px]">
            <span aria-hidden="true" className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-full bg-fill-tertiary">
              <Icon size={16} />
            </span>
            <span className="flex-1 text-subheadline"><strong>{t(bold)}</strong>{t(text)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-footnote text-text-secondary">{t('tour.steps.offlineCard.note')}</p>
    </>
  )
}

/**
 * The glass hint card (docs/WELCOME_DESIGN.md §3.2): section name, a five-part progress bar, the title, the body, then
 * either a tap line or Next. A modal dialog that scrolls inside itself at large text sizes; Skip is a 44 x 44 target.
 * `place` is { side: 'below' | 'above', top, bottom, arrowX } from TourSpotlight's measurements.
 */
const GuideCard = forwardRef(function GuideCard({
  step, title, body, tap, place, onNext, onSkip, finish = false,
}, ref) {
  const { t } = useSettings()
  const titleId = useId()
  const bodyId = useId()
  const section = TOUR_SECTIONS[step.section]
  const sectionName = t(section.labelKey)
  const below = place.side === 'below'
  const offlineCard = step.id === 'offline-card'
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-testid="tour-card"
      data-step={step.id}
      tabIndex={-1}
      className="glass fixed inset-x-4 flex flex-col rounded-[16px] bg-card pt-2 outline-none"
      style={{
        zIndex: 'var(--z-tour)',
        background: 'var(--color-card)',
        top: below ? place.top : undefined,
        bottom: below ? undefined : place.bottom,
        maxHeight: 'calc(100dvh - max(16px, var(--safe-top)) - 16px)',
      }}
    >
      <span
        aria-hidden="true"
        className={clsx('absolute h-[14px] w-[14px] rotate-45 bg-card', below
          ? '-top-[7px] border-l-[0.5px] border-t-[0.5px] border-border'
          : '-bottom-[7px] border-b-[0.5px] border-r-[0.5px] border-border')}
        style={{ left: place.arrowX }}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <div className="flex min-h-[44px] items-center gap-3">
          <span className="flex-shrink-0 text-caption-1 font-semibold text-text-secondary" aria-hidden="true">{sectionName}</span>
          <span aria-hidden="true" className="flex flex-1 gap-1">
            {TOUR_SECTIONS.map((item, index) => (
              <span key={item.key} className={clsx('h-1 flex-1 rounded-full', index <= step.section ? 'bg-tint' : 'bg-fill')} />
            ))}
          </span>
          <button
            type="button"
            onClick={onSkip}
            className="ios-press min-h-[44px] min-w-[44px] flex-shrink-0 px-0.5 text-right text-callout text-tint"
          >
            {t('tour.skip')}
          </button>
        </div>
        <p className="sr-only">{t('tour.progress').replace('{section}', sectionName).replace('{n}', String(step.section + 1))}</p>
        <h2 id={titleId} className="text-title-3 font-display">{title}</h2>
        {offlineCard ? (
          <>
            <p id={bodyId} className="sr-only">{body}</p>
            <OfflineBody />
          </>
        ) : (
          <p id={bodyId} className="mt-1.5 text-callout text-text-secondary">{body}</p>
        )}
        {step.extra === 'ask' && <NotificationsAsk />}
        {step.extra === 'browser' && <NotificationsAsk browser />}
      </div>
      <div className={clsx('mt-3 flex min-h-[44px] flex-shrink-0 items-center px-4 pb-4', tap ? 'justify-start' : 'justify-end')}>
        {tap ? (
          <p className="flex items-center gap-2 text-subheadline font-semibold text-tint">
            <Pointer size={18} aria-hidden="true" />{tap}
          </p>
        ) : (
          <Button onClick={onNext}>{finish ? t('tour.finish') : t('tour.next')}</Button>
        )}
      </div>
    </div>
  )
})

export default GuideCard
