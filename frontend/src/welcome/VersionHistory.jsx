import { ChevronRight } from 'lucide-react'
import { lazy, Suspense } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import Link from '../components/ios/TransitionLink'
import { useSettings } from '../contexts/SettingsContext'
import { useNavBar } from '../navigation/useNavBar'
import ReleaseBlock from './ReleaseBlock'
import { isNonprod } from './channel'
import { current, findRelease, formatReleaseDate, nextRelease, releaseTitle, releases } from './releases'

// Only built for nonprod (and the dev server); a production build folds TEST_TOOLS to false and drops the chunk.
const TestWhatsNew = (import.meta.env.DEV || __RELEASE_CHANNEL__ === 'nonprod') ? lazy(() => import('./TestWhatsNew')) : null

const NAV_BAR = {}
const ROW_CLASS = [
  'relative flex min-h-[76px] w-full items-center gap-3 px-4 py-[11px] ios-press active:bg-elevated',
  'after:pointer-events-none after:absolute after:bottom-0 after:left-4 after:right-0 after:h-[0.5px] after:bg-border last:after:hidden',
].join(' ')

function ReleaseRow({ release, running, t }) {
  return (
    <Link to={`/settings/about/versions/${release.id}`} className={ROW_CLASS} data-testid={`version-row-${release.id}`}>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-headline">
          {releaseTitle(release)}
          {running && (
            <span className="rounded-full bg-fill-tertiary px-2 py-px text-caption-1 font-semibold text-text-primary">{t('welcome.youHaveThis')}</span>
          )}
        </p>
        <p className="text-footnote text-text-secondary">{formatReleaseDate(release)}</p>
        <p className="mt-0.5 text-subheadline text-text-secondary">{release.summary}</p>
      </div>
      <ChevronRight size={18} strokeWidth={2.25} className="flex-shrink-0 text-text-tertiary" aria-hidden="true" />
    </Link>
  )
}

/** Nonprod only: the draft of the release being tested (docs/WELCOME_DESIGN.md §5.4). */
function ComingNext({ draft, t }) {
  return (
    <div className="overflow-hidden rounded-xl bg-card shadow-[inset_0_0_0_1px_rgba(255,214,10,0.45)]" data-testid="coming-next">
      <div className="px-4 pb-2 pt-3">
        <p><span className="rounded-full bg-yellow px-2.5 py-0.5 text-caption-1 font-semibold text-black">{t('welcome.comingNext')}</span></p>
      </div>
      <ReleaseBlock
        release={{ ...draft, id: 'next' }}
        heading="h2"
        first
        date={t('welcome.draftNote')}
        className="!border-t-0 !pt-0"
      />
      <Link
        to="/settings/about/versions/next"
        data-testid="coming-next-notes"
        className="ios-press relative flex min-h-[44px] items-center justify-between border-t-[0.5px] border-border px-4 text-subheadline text-tint"
      >
        {t('welcome.seeFullNotes')}
        <ChevronRight size={18} strokeWidth={2.25} className="text-text-tertiary" aria-hidden="true" />
      </Link>
    </div>
  )
}

function List({ t }) {
  useNavBar(NAV_BAR)
  const running = current()?.id
  const draft = isNonprod() ? nextRelease() : null
  return (
    <div className="flex flex-col gap-3" data-testid="version-history">
      {draft && <ComingNext draft={draft} t={t} />}
      {draft && TestWhatsNew && <Suspense fallback={null}><TestWhatsNew /></Suspense>}
      <div className="overflow-hidden rounded-xl bg-card">
        {releases().map((release) => <ReleaseRow key={release.id} release={release} running={release.id === running} t={t} />)}
      </div>
      <p className="px-4 text-footnote text-text-secondary">{t('welcome.namesFooter')}</p>
    </div>
  )
}

function Detail({ id, t }) {
  useNavBar(NAV_BAR)
  const isDraft = id === 'next' && isNonprod()
  const release = isDraft ? nextRelease() : findRelease(id)
  if (!release) return <Navigate to="/settings/about/versions" replace />
  return (
    <div className="flex flex-col gap-5" data-testid="version-detail">
      <header className="px-1">
        <h1 className="text-large-title text-text-primary">{releaseTitle(release)}</h1>
        <p className="text-footnote text-text-secondary">{isDraft ? t('welcome.draftNote') : formatReleaseDate(release)}</p>
        <p className="mt-1.5 text-callout text-text-secondary">{release.summary}.</p>
      </header>
      <ReleaseBlock release={release} level="details" />
    </div>
  )
}

/** Settings › About › Version history, and the page of one release. Both read the bundled file, so they work offline. */
export default function VersionHistory() {
  const { t } = useSettings()
  const { id } = useParams()
  return id ? <Detail id={id} t={t} /> : <List t={t} />
}
