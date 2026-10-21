import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useSettings } from '../../contexts/SettingsContext'
import PixelArt from './PixelArt'
import Splash from './Splash'
import { BALL_BASE, BALL_LID, GROUNDS } from './art'
import { isSplashEntry, splashLanguage, starterEntry } from './entryStore'

const SLOW_MOTION = 4
const SHEET_PX = 4

/** ?grounds=1: every type's ground with the ball resting on it, for reviewing the art. */
function GroundSheet() {
  const px = value => `${value * SHEET_PX}px`
  return (
    <div className="min-h-dvh bg-black px-6 py-8" data-testid="splash-ground-sheet">
      <ul className="mx-auto grid max-w-[720px] grid-cols-2 gap-x-8 gap-y-5 sm:grid-cols-3">
        {Object.entries(GROUNDS).map(([type, ground]) => (
          <li key={type} className="flex flex-col items-center gap-1.5">
            <div className="relative" style={{ width: px(48), height: px(19) }}>
              <div className="absolute" style={{ left: px(16), bottom: px(1 + (ground.lift ?? 0)), width: px(16), height: px(16) }}>
                <PixelArt art={BALL_LID} className="block h-1/2 w-full" />
                <PixelArt art={BALL_BASE} className="block h-1/2 w-full" />
              </div>
              <PixelArt art={ground} className="absolute bottom-0 left-0 block" style={{ width: px(48), height: px(5) }} />
            </div>
            <p className="text-footnote capitalize text-text-secondary">{type}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}

function previewStarter(language, shiny, type) {
  const starter = { ...starterEntry(splashLanguage(language)), ...(type ? { types: [type] } : null) }
  return shiny ? { ...starter, shiny, sprite_url: '/api/pokedex/images/showdown-shiny/25.gif' } : starter
}

/**
 * DEV only (/__splash, like /__ios): the splash with a fixed Pokémon, the bundled starter unless
 * ?id= asks the server for another. ?shiny=1 makes it shiny, ?slow=1 runs it 4x slower,
 * ?still=1 shows the Reduce Motion version, ?hold=1 waits for a tap, ?wait=3000 delivers the
 * Pokémon that late (the extra twitches), ?controls=0 hides these switches (snapshots), and
 * ?type=ghost swaps the starter's type (its ground and light); ?grounds=1 shows every type's
 * ground instead.
 */
export default function SplashPreview() {
  const [params] = useSearchParams()
  return params.get('grounds') === '1' ? <GroundSheet /> : <SplashStage />
}

function SplashStage() {
  const { t, language } = useSettings()
  const [params, setParams] = useSearchParams()
  const id = Number(params.get('id')) || null
  const flag = key => params.get(key) === '1'
  const wait = Number(params.get('wait')) || 0
  const [run, setRun] = useState(0)
  const [finished, setFinished] = useState(false)
  const [entry, setEntry] = useState(() => (wait || id ? null : previewStarter(language, flag('shiny'), params.get('type'))))

  useEffect(() => {
    let cancelled = false
    const deliver = value => {
      if (wait) setTimeout(() => !cancelled && setEntry(value), wait)
      else setEntry(value)
    }
    if (!id) {
      if (wait) setEntry(null)
      deliver(previewStarter(language, flag('shiny'), params.get('type')))
    } else {
      setEntry(null)
      const query = new URLSearchParams({ id: String(id), lang: splashLanguage(language) })
      if (flag('shiny')) query.set('shiny', 'true')
      fetch(`/api/pokedex/splash?${query}`)
        .then(response => (response.ok ? response.json() : null))
        .then(data => isSplashEntry(data) && !cancelled && deliver(data))
        .catch(() => {})
    }
    return () => {
      cancelled = true
    }
  }, [id, language, wait, run, params.get('type')]) // eslint-disable-line react-hooks/exhaustive-deps

  const replay = () => {
    setRun(value => value + 1)
    setFinished(false)
  }

  const setParam = (key, value) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    setParams(next, { replace: true })
    replay()
  }

  const toggle = (key, label) => (
    <label className="flex min-h-[36px] items-center gap-2 rounded-full bg-fill-tertiary px-3 text-footnote">
      <input type="checkbox" checked={flag(key)} onChange={event => setParam(key, event.target.checked ? '1' : null)} />
      {label}
    </label>
  )

  return (
    <div className="min-h-dvh bg-bg text-text-primary">
      {finished ? (
        <p className="px-6 pt-28 text-subheadline text-text-secondary">The splash closed. Replay to see it again.</p>
      ) : (
        <Splash
          key={`${run}-${id}-${flag('shiny')}-${params.get('type')}`}
          entry={entry}
          spriteSrc={entry?.sprite_url ?? null}
          mode={flag('still') ? 'still' : 'full'}
          speed={flag('slow') ? SLOW_MOTION : 1}
          hold={flag('hold')}
          t={t}
          language={language}
          onFinish={() => setFinished(true)}
          onWaitTimeout={() => setEntry(current => current ?? starterEntry(splashLanguage(language)))}
        />
      )}
      {params.get('controls') !== '0' && (
        <div
          className="fixed left-3 right-3 top-[max(12px,env(safe-area-inset-top))] z-[10001] flex flex-wrap items-center gap-2"
          data-testid="splash-preview-controls"
        >
          <button type="button" onClick={replay} className="min-h-[36px] rounded-full bg-accent px-4 text-footnote font-semibold text-on-accent">
            Replay
          </button>
          {toggle('slow', `Slow motion (${SLOW_MOTION}x)`)}
          {toggle('still', 'Reduce Motion')}
          {toggle('hold', 'Hold')}
          {toggle('shiny', 'Shiny')}
          <label className="flex min-h-[36px] items-center gap-2 rounded-full bg-fill-tertiary px-3 text-footnote">
            No.
            <input
              type="number"
              min="1"
              max="1025"
              defaultValue={id || ''}
              placeholder="25"
              className="w-16 bg-transparent"
              onBlur={event => setParam('id', event.target.value || null)}
            />
          </label>
        </div>
      )}
    </div>
  )
}
