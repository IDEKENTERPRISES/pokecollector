import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, HelpCircle, Share2, X } from 'lucide-react'
import toast from 'react-hot-toast'
import { useSettings } from '../contexts/SettingsContext'
import { ensurePuzzle, spriteSource } from '../components/splash/prefetch'
import { readPuzzle } from '../components/splash/wtp'
import { fill } from '../components/splash/format'
import ActionSheet from '../components/ios/ActionSheet'
import { readResults, recordResult, shareText } from './daily'
import { currentAccent, currentFont, renderShareImage, shareImageSpec, sharePicture } from './shareImage'
import { flushWtpResults } from './wtpResults'

/**
 * The Who's That Pokémon tile (engagement P7): today's silhouette, four choices, one try. The puzzle
 * comes from the device (fetched ahead with the splash), so it plays offline; the answer is kept
 * locally first and sent to the server when there is a connection.
 */
export default function WhosThatPokemon({ date, userId, language, serverPlayed = false, streak = 0 }) {
  const { t, language: locale } = useSettings()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const picture = useRef(null)
  const [results, setResults] = useState(() => readResults(userId))
  const result = results[date]

  const { data: puzzle } = useQuery({
    queryKey: ['wtp-puzzle', date, language],
    queryFn: async () => (await ensurePuzzle(date, { language })) ?? null,
    initialData: () => readPuzzle(date, language) ?? undefined,
    staleTime: 6 * 60 * 60 * 1000,
    retry: 1,
  })

  const [image, setImage] = useState(null)
  useEffect(() => {
    if (!puzzle) return undefined
    let revoke = null
    let cancelled = false
    spriteSource(puzzle).then((url) => {
      if (cancelled) {
        if (url?.startsWith('blob:')) URL.revokeObjectURL(url)
        return
      }
      if (url?.startsWith('blob:')) revoke = url
      setImage(url)
    })
    return () => {
      cancelled = true
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [puzzle])

  const sync = useCallback(async () => {
    const sent = await flushWtpResults(userId)
    if (sent > 0) {
      setResults(readResults(userId))
      queryClient.invalidateQueries({ queryKey: ['today-card'] })
    }
  }, [queryClient, userId])

  useEffect(() => {
    sync()
    window.addEventListener('online', sync)
    return () => window.removeEventListener('online', sync)
  }, [sync])

  const choose = (dexId) => {
    if (!puzzle || result) return
    recordResult(userId, date, { choice: dexId, correct: dexId === puzzle.answer })
    setResults(readResults(userId))
    sync()
  }

  const buildPicture = useCallback(() => renderShareImage(shareImageSpec({
    t,
    date,
    result: results[date],
    results,
    streak,
    accent: currentAccent(),
    fontFamily: currentFont(),
    locale: locale || undefined,
  }), image), [t, date, results, streak, image, locale])

  // Draw the picture as soon as the choice opens, so sharing it happens inside the tap.
  const openShare = () => {
    picture.current = buildPicture()
    setShareOpen(true)
  }

  const shareAsText = async () => {
    const text = shareText({ t, date, results, streak })
    try {
      if (navigator.share) await navigator.share({ text })
      else {
        await navigator.clipboard.writeText(text)
        toast.success(t('wtp.shared'))
      }
    } catch {
      // the trainer closed the share sheet
    }
  }

  const shareAsPicture = async () => {
    try {
      const blob = await (picture.current ?? buildPicture())
      if (!blob) {
        toast.error(t('wtp.shareImageFailed'))
        return
      }
      if (await sharePicture(blob) === 'downloaded') toast.success(t('wtp.shareDownloaded'))
    } catch {
      toast.error(t('wtp.shareImageFailed'))
    }
  }

  const answerName = puzzle?.choices.find(choice => choice.dex_id === puzzle.answer)?.name ?? ''
  const revealed = Boolean(result)
  const played = revealed || serverPlayed

  return (
    <div className="border-t-[0.5px] border-border px-4 py-3" data-testid="wtp-tile" data-played={played ? 'true' : 'false'}>
      <div className="flex min-h-[44px] items-center gap-3">
        <span className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-full bg-fill-tertiary" aria-hidden="true">
          <HelpCircle size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-headline text-text-primary">{t('wtp.title')}</p>
          <p className="text-footnote text-text-secondary">{played && !revealed ? t('wtp.played') : t('wtp.subtitle')}</p>
        </div>
        {!played && puzzle && !open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="ios-press min-h-[44px] flex-shrink-0 rounded-full bg-tint px-4 text-subheadline font-semibold text-on-accent"
          >
            {t('wtp.play')}
          </button>
        )}
      </div>

      {!played && !puzzle && <p className="mt-2 text-footnote text-text-secondary">{t('wtp.unavailable')}</p>}

      {puzzle && (open || revealed) && (
        <div className="mt-3 space-y-3">
          <div className="grid place-items-center rounded-2xl bg-fill-tertiary py-3">
            {image && (
              <img
                src={image}
                alt={revealed ? fill(t('wtp.revealedAlt'), { name: answerName }) : t('wtp.silhouetteAlt')}
                width="140"
                height="140"
                data-testid="wtp-image"
                data-revealed={revealed ? 'true' : 'false'}
                className="h-[140px] w-[140px] object-contain motion-safe:transition-[filter] motion-safe:duration-500"
                style={{ filter: revealed ? 'none' : 'brightness(0)' }}
              />
            )}
          </div>
          <div role="group" aria-label={t('wtp.choices')} className="grid grid-cols-2 gap-2">
            {puzzle.choices.map((choice) => {
              const isAnswer = choice.dex_id === puzzle.answer
              const isPick = result?.choice === choice.dex_id
              const tone = !revealed
                ? 'bg-fill-tertiary text-text-primary'
                : isAnswer
                  ? 'bg-green/25 text-text-primary ring-2 ring-green'
                  : isPick
                    ? 'bg-red/20 text-text-primary ring-2 ring-red'
                    : 'bg-fill-tertiary text-text-secondary'
              return (
                <button
                  key={choice.dex_id}
                  type="button"
                  disabled={revealed}
                  onClick={() => choose(choice.dex_id)}
                  data-testid={`wtp-choice-${choice.dex_id}`}
                  className={`ios-press flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-subheadline font-semibold disabled:opacity-100 ${tone}`}
                >
                  {revealed && isAnswer && <Check size={16} aria-label={t('wtp.correctMark')} />}
                  {revealed && isPick && !isAnswer && <X size={16} aria-label={t('wtp.wrongMark')} />}
                  <span className="break-words">{choice.name}</span>
                </button>
              )
            })}
          </div>
          {revealed && (
            <div className="space-y-2" aria-live="polite">
              <p className="text-headline text-text-primary" data-testid="wtp-result">
                {fill(t(result.correct ? 'wtp.won' : 'wtp.lost'), { name: answerName })}
              </p>
              {!result.sent && <p className="text-footnote text-text-secondary">{t('wtp.pending')}</p>}
              <button
                type="button"
                onClick={openShare}
                data-testid="wtp-share"
                className="ios-press inline-flex min-h-[44px] items-center gap-2 rounded-full bg-fill-tertiary px-4 text-subheadline font-semibold text-tint"
              >
                <Share2 size={16} aria-hidden="true" />
                {t('wtp.share')}
              </button>
              <ActionSheet
                isOpen={shareOpen}
                onClose={() => setShareOpen(false)}
                title={t('wtp.shareChoose')}
                actions={[
                  { label: t('wtp.shareAsText'), onSelect: shareAsText },
                  { label: t('wtp.shareAsPicture'), onSelect: shareAsPicture },
                ]}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
