import { CloudOff } from 'lucide-react'
import PokeBall from '../../components/ios/PokeBall'
import { useSettings } from '../../contexts/SettingsContext'
import { PodiumList, ChallengeBoard, ChallengeHero, ChallengeResultCard, useChallenge, useMinuteClock, useRiseOnce } from './ChallengeParts'
import { anyoneStarted } from './challengeFormat'

function OfflineNote() {
  const { t } = useSettings()
  return (
    <p role="status" className="flex items-start gap-1.5 px-1 text-footnote text-text-secondary" data-testid="challenge-offline">
      <CloudOff size={14} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
      {t('challenge.offlineSaved')}
    </p>
  )
}

function OfflineEmpty() {
  const { t } = useSettings()
  return (
    <section className="flex flex-col items-center px-4 pt-10 text-center" data-testid="challenge-offline-empty">
      <span className="relative">
        <PokeBall size={56} top="var(--color-fill)" />
        <CloudOff size={18} aria-hidden="true" className="absolute -bottom-1 -right-1 rounded-full bg-bg p-0.5 text-text-secondary" />
      </span>
      <p className="mt-4 max-w-[300px] text-subheadline text-text-secondary">{t('challenge.offlineNone')}</p>
    </section>
  )
}

function Podium({ data, viewerId }) {
  const { t } = useSettings()
  const placed = data.board.filter(entry => entry.place)
  const rise = useRiseOnce(data.week, placed.length >= 3)
  return (
    <section aria-labelledby="challenge-podium-title">
      <div className="mb-2 flex items-baseline justify-between px-0.5">
        <h2 id="challenge-podium-title" className="text-title-3 font-display">{t('challenge.podiumTitle')}</h2>
        <span className="text-footnote text-text-secondary">{t('challenge.podiumHint')}</span>
      </div>
      <PodiumList entries={placed} size="md" target={data.challenge.target} viewerId={viewerId} rise={rise} />
    </section>
  )
}

/** Leaderboard › Challenge (docs/SOCIAL_DESIGN.md §7.4 to §7.6): the week's goal, your progress, the podium and the board. */
export default function ChallengePage() {
  const { t } = useSettings()
  const now = useMinuteClock()
  const { data, isLoading, error, saved, viewerId } = useChallenge()

  if (isLoading && !data) {
    return (
      <div className="flex flex-col gap-4" data-testid="challenge-loading">
        <div className="skeleton h-[150px] rounded-[22px]" />
        <div className="skeleton h-[160px] rounded-xl" />
        <div className="skeleton h-[200px] rounded-xl" />
      </div>
    )
  }
  if (!data) {
    // No answer and nothing saved: offline gets the quiet state, a server error the usual red card.
    return error && error.response
      ? <div className="card text-sm text-red" role="alert">{t('challenge.loadFailed')}</div>
      : <OfflineEmpty />
  }

  const last = data.last
  const showBoard = anyoneStarted(data.board)
  const myEntry = data.board.some(entry => entry.user?.id === viewerId)
  return (
    <>
      {saved && <OfflineNote />}
      {last && <ChallengeResultCard last={last} />}
      <ChallengeHero data={data} now={now} thisWeek={Boolean(last)} />
      {showBoard && <Podium data={data} viewerId={viewerId} />}
      {showBoard && <ChallengeBoard board={data.board} viewerId={viewerId} challenge={data.challenge} />}
      {data.me && data.me.on_board === false && !myEntry && (
        <p className="px-1 text-footnote text-text-secondary" data-testid="challenge-off-board">{t('challenge.offBoard')}</p>
      )}
    </>
  )
}
