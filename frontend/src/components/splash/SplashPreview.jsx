import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useSettings } from '../../contexts/SettingsContext'
import Splash from './Splash'
import { isSplashEntry, splashLanguage, starterEntry } from './entryStore'

const SLOW_MOTION = 4

function previewStarter(language, shiny) {
  const starter = starterEntry(splashLanguage(language))
  return shiny ? { ...starter, shiny, sprite_url: '/api/pokedex/images/showdown-shiny/25.gif' } : starter
}

/**
 * DEV only (/__splash, like /__ios): the splash with a fixed Pokémon, the bundled starter unless
 * ?id= asks the server for another. ?shiny=1 makes it shiny, ?slow=1 runs it 4x slower,
 * ?still=1 shows the Reduce Motion version, ?hold=1 waits for a tap, ?wait=3000 delivers the
 * Pokémon that late (the extra twitches), ?controls=0 hides these switches (snapshots).
 */
export default function SplashPreview() {
  const { t, language } = useSettings()
  const [params, setParams] = useSearchParams()
  const id = Number(params.get('id')) || null
  const flag = key => params.get(key) === '1'
  const wait = Number(params.get('wait')) || 0
  const [run, setRun] = useState(0)
  const [finished, setFinished] = useState(false)
  const [entry, setEntry] = useState(() => (wait || id ? null : previewStarter(language, flag('shiny'))))

  useEffect(() => {
    let cancelled = false
    const deliver = value => {
      if (wait) setTimeout(() => !cancelled && setEntry(value), wait)
      else setEntry(value)
    }
    if (!id) {
      if (wait) setEntry(null)
      deliver(previewStarter(language, flag('shiny')))
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
  }, [id, language, wait, run]) // eslint-disable-line react-hooks/exhaustive-deps

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
          key={`${run}-${id}-${flag('shiny')}`}
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
