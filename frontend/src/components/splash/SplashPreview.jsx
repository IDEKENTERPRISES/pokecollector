import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useSettings } from '../../contexts/SettingsContext'
import Splash from './Splash'
import { isSplashEntry, starterEntry } from './entryStore'

const SLOW_MOTION = 4

/**
 * DEV only (/__splash, like /__ios): the splash with a fixed Pokémon, the bundled starter unless
 * ?id= asks the server for another. ?slow=1 runs it 4x slower, ?still=1 shows the Reduce Motion
 * version, ?hold=1 waits for a tap, ?controls=0 hides these switches (snapshots).
 */
export default function SplashPreview() {
  const { t, language } = useSettings()
  const [params, setParams] = useSearchParams()
  const id = Number(params.get('id')) || null
  const flag = key => params.get(key) === '1'
  const [entry, setEntry] = useState(() => starterEntry(language))
  const [run, setRun] = useState(0)
  const [finished, setFinished] = useState(false)

  useEffect(() => {
    if (!id) {
      setEntry(starterEntry(language))
      return undefined
    }
    let cancelled = false
    fetch(`/api/pokedex/splash?id=${id}&lang=${encodeURIComponent(language)}`)
      .then(response => (response.ok ? response.json() : null))
      .then(data => {
        if (!cancelled && isSplashEntry(data)) setEntry(data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [id, language])

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
          key={`${run}-${entry.dex_id}`}
          entry={entry}
          spriteSrc={entry.sprite_url}
          mode={flag('still') ? 'still' : 'full'}
          speed={flag('slow') ? SLOW_MOTION : 1}
          hold={flag('hold')}
          t={t}
          language={language}
          onFinish={() => setFinished(true)}
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
          <label className="flex min-h-[36px] items-center gap-2 rounded-full bg-fill-tertiary px-3 text-footnote">
            No.
            <input
              type="number"
              min="1"
              max="1025"
              defaultValue={id || ''}
              placeholder="25"
              className="w-16 bg-transparent"
              onKeyDown={event => event.stopPropagation()}
              onBlur={event => setParam('id', event.target.value || null)}
            />
          </label>
        </div>
      )}
    </div>
  )
}
