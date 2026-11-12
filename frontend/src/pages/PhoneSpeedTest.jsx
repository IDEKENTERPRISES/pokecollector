import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { Camera, Download, Play, Trash2 } from 'lucide-react'
import api from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useNavBar } from '../navigation/useNavBar'
import { createPostGuard, speedRunRequest } from '../phonespeed/upload'
import { checkManifest } from '../phonescan/matcher/guard'
import { prepareMatchPhoto } from '../phonespeed/matchPhoto'
import { describeDecision, estimateMemory, matcherOutcome, runMatcherRuns, STAGE_ROWS, summariseTimings, variantText } from '../phonespeed/matcherRun'
import { clearPartial, crashedRunBody, describeIos, loadPartial, markStep, newPartial, previousCrash, recordStep, reportPreviousCrash } from '../phonespeed/plan'
import {
  CACHE_NAME, cacheState, downloadMissing, megabytes, networkHelpers, readCached, removeTestFiles, testFiles, totalBytes, MANIFEST_PATH,
} from '../phonespeed/bundleCache'

const NAV_BAR = {}
const SAMPLE_URL = '/phone-speed-sample.jpg'
const button = 'inline-flex min-h-[40px] items-center gap-1.5 rounded-full bg-accent/20 px-4 text-subheadline font-semibold text-tint ios-press disabled:opacity-40'
const ms = value => (value === null || value === undefined ? '–' : `${Math.round(value).toLocaleString()} ms`)

/** Rows with first run and median of 5 (the result of one runtime step). */
export function ResultsTable({ steps, rows, medianLabel = 'Median of 5', testId = 'phone-speed-results' }) {
  return (
    <table className="w-full text-footnote" data-testid={testId}>
      <thead>
        <tr className="text-left text-text-secondary"><th className="py-1 pr-2 font-normal">Step</th><th className="px-1 font-normal">First</th><th className="pl-1 font-normal">{medianLabel}</th></tr>
      </thead>
      <tbody>
        {steps.map(([id, title]) => {
          const row = rows[id]
          return (
            <tr key={id} className="border-t border-separator align-top" data-testid={`phone-speed-row-${id}`}>
              <td className="py-1 pr-2">{title}{row?.note && <div className="text-text-secondary">{row.note}</div>}</td>
              {row?.error
                ? <td colSpan={2} className="px-1 text-red-500">{row.error}</td>
                : <><td className="px-1 tabular-nums">{row ? ms(row.first) : ''}</td><td className="pl-1 tabular-nums">{row ? ms(row.median) : ''}</td></>}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function Section({ title, children }) {
  return (
    <section className="space-y-2">
      <h2 className="px-4 text-footnote text-text-secondary">{title}</h2>
      <div className="space-y-2 rounded-xl bg-card px-4 py-3">{children}</div>
    </section>
  )
}

export default function PhoneSpeedTest() {
  const { user } = useAuth()
  useNavBar(NAV_BAR)
  const [manifest, setManifest] = useState(null)
  const [manifestError, setManifestError] = useState(null)
  const [state, setState] = useState(null) // cacheState of the files the test needs
  const [progress, setProgress] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(null)
  const [rows, setRows] = useState({})
  const [phase, setPhase] = useState(null)
  const [result, setResult] = useState(null)
  const [sent, setSent] = useState(null)
  const [runtime, setRuntime] = useState(null) // the lazily loaded runtime module: nothing of it is imported until a test starts
  const photo = useRef(null)
  const fileInput = useRef(null)
  const [photoName, setPhotoName] = useState(null)
  const [crash, setCrash] = useState(null)
  const crashHandled = useRef(false)
  const postGuard = useRef(createPostGuard()) // one post per run id: the final post and a partial or crash post never both go out
  const hasGpu = Boolean(globalThis.navigator?.gpu)
  // the "Full phone matcher" run (step 3d)
  const [matcherMode, setMatcherMode] = useState('auto')
  // the safest combination first: three runs, a fresh worker for each (frees its memory), no overlap, the server's reader ladder on WebAssembly
  const [matcherRuns, setMatcherRuns] = useState(3)
  const [matcherRestart, setMatcherRestart] = useState(true)
  const [matcherLow, setMatcherLow] = useState(true) // strictly one thing at a time: the model first, then the picture index, then the reader, each released after use
  const [matcherOverlap, setMatcherOverlap] = useState(false)
  const [matcherOcr, setMatcherOcr] = useState('wasm')
  const [matcherLadder, setMatcherLadder] = useState('server')
  const [matcherState, setMatcherState] = useState({ status: 'idle' }) // idle | loading | running | done | error
  const [matcherResults, setMatcherResults] = useState([])
  const [matcherInfo, setMatcherInfo] = useState(null)
  const [matcherSent, setMatcherSent] = useState(null)
  const [cardDb, setCardDb] = useState(null) // {present} once checked
  const matcherClient = useRef(null)

  const isAdmin = user?.role === 'admin'

  useEffect(() => {
    if (!isAdmin) return
    import('../phonespeed/runtime').then(module => {
      setRuntime(module)
      // A page that died during a run left a flag and the steps that had finished: post them as a run (no photo), once.
      setCrash(previousCrash())
      if (crashHandled.current) return
      crashHandled.current = true
      reportPreviousCrash(body => postGuard.current.once(body.client_id || 'crash', () => api.post('/card-match/phone-speed', body)), module.readDevice())
        .then(step => { if (step) setMessage(`The last run crashed during "${step}". The steps that had finished were saved on the server.`) })
        .catch(() => setMessage('The last run crashed. Could not save its partial results on the server.'))
    })
  }, [isAdmin])

  const entries = manifest ? testFiles(manifest, { webgpu: hasGpu }) : []

  const refreshState = useCallback(async list => {
    if (!list.length || !globalThis.caches) return
    setState(await cacheState(await caches.open(CACHE_NAME), list))
  }, [])

  useEffect(() => {
    if (!isAdmin) return undefined
    let live = true
    networkHelpers(api).getJson(MANIFEST_PATH).then(data => {
      if (!live) return
      setManifest(data)
      refreshState(testFiles(data, { webgpu: Boolean(globalThis.navigator?.gpu) }))
    }).catch(error => live && setManifestError(error.response?.status === 404 ? 'The phone bundle is not built on the server yet.' : 'Could not read the phone bundle manifest.'))
    return () => { live = false }
  }, [isAdmin, refreshState])

  useEffect(() => {
    if (!isAdmin) return undefined
    let live = true
    import('../offline/carddb/store')
      .then(module => module.createCardDbStore().getMeta('en'))
      .then(meta => live && setCardDb({ present: Boolean(meta), cards: meta?.cardCount ?? null }), () => live && setCardDb({ present: false }))
    return () => { live = false }
  }, [isAdmin])

  useEffect(() => () => { matcherClient.current?.terminate?.() }, []) // leaving the page frees the worker and its models

  useEffect(() => { if (String(crash || '').startsWith('matcher')) setMatcherMode('wasm') }, [crash]) // the last matcher run crashed: start on the safe backend

  if (!isAdmin) return <Navigate to="/settings" replace />

  const connection = globalThis.navigator?.connection
  const download = async () => {
    const need = state?.missingBytes ?? totalBytes(entries)
    const cellular = connection?.type === 'cellular' || connection?.saveData
    const warning = `Download ${megabytes(need)} for the speed test? ${cellular ? 'This looks like mobile data. ' : ''}Use Wi-Fi: the files are large.`
    if (!window.confirm(warning)) return
    setBusy(true)
    setMessage(null)
    try {
      const cache = await caches.open(CACHE_NAME)
      const { getBytes } = networkHelpers(api)
      await downloadMissing({ cache, entries, getBytes, subtle: crypto.subtle, onProgress: setProgress })
      setMessage('Files downloaded and checked against the manifest.')
    } catch (error) {
      setMessage(`Download failed: ${error.message}`)
    } finally {
      setBusy(false)
      setProgress(null)
      refreshState(entries)
    }
  }

  const remove = async () => {
    await removeTestFiles(caches)
    setMessage('Test files removed from this phone.')
    refreshState(entries)
  }

  const pick = event => {
    const file = event.target.files?.[0]
    if (!file) return
    photo.current = file // stays in memory on the phone: never uploaded
    setPhotoName(file.name || 'photo')
  }

  const run = async () => {
    if (!runtime || !manifest) return
    setBusy(true)
    setRows({})
    setResult(null)
    setSent(null)
    setMessage(null)
    const wasCrash = runtime.previousCrash()
    try {
      const cache = await caches.open(CACHE_NAME)
      const files = { manifest, read: path => readCached(cache, entries.find(item => item.path === path) || { path, sha256: '', size: -1 }) }
      const outcome = await runtime.runSpeedTest({
        files,
        photoSource: photo.current || SAMPLE_URL,
        onRow: (id, row) => setRows(current => ({ ...current, [id]: row })),
        onPhase: setPhase,
      })
      outcome.device.crashedBefore = Boolean(wasCrash)
      outcome.device.crashedStep = wasCrash || null
      outcome.device.photoSource = photo.current ? 'taken here' : 'built-in sample'
      setResult(outcome)
      await send(outcome)
    } catch (error) {
      setMessage(`The test stopped: ${error.message}`)
      const partial = loadPartial() // the run ended early: keep what finished
      if (partial && !postGuard.current.has(partial.runId)) {
        postGuard.current.once(partial.runId, () => api.post('/card-match/phone-speed', crashedRunBody(partial, 'stopped_early', device))).then(() => { clearPartial(); markStep(null) }).catch(() => {})
      }
    } finally {
      setBusy(false)
      setPhase(null)
    }
  }

  const send = async outcome => {
    try {
      const request = speedRunRequest(outcome, photo.current)
      await postGuard.current.once(outcome.runId || 'final', () => api.post('/card-match/phone-speed', request.body, request.multipart ? { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000 } : undefined))
      setSent(request.multipart
        ? 'Numbers and your photo saved on the server (admins only). The server now matches the photo for comparison.'
        : 'Numbers saved on the server (the built-in sample is not uploaded).')
    } catch {
      setSent('Could not save the numbers on the server. Tap "Send numbers" to try again.')
    }
  }

  const guard = manifest ? checkManifest(manifest) : null

  const releaseMatcher = async () => {
    try { await matcherClient.current?.release() } catch { /* nothing loaded */ }
    matcherClient.current?.terminate?.()
    matcherClient.current = null
    setMatcherInfo(null)
    setMessage('The matcher was released: its models and indexes are out of memory.')
  }

  const runMatcher = async () => {
    if (!runtime || !manifest || !guard?.ok) return
    setBusy(true)
    setMatcherResults([])
    setMatcherSent(null)
    setMessage(null)
    setMatcherState({ status: 'loading', stage: 'preparing the photo' })
    const variant = variantText({ restart: matcherRestart, overlap: matcherOverlap, ocrBackend: matcherOcr, ladder: matcherLadder, runs: matcherRuns, lowMemory: matcherLow })
    // crash-safe like the step 2 test: the stage that is running is flagged, every finished stage is saved at once, and a page that dies is
    // posted on the next load as a crashed run that names the stage (reportPreviousCrash).
    const base = { ...runtime.readDevice(), photoSource: photo.current ? 'taken here' : 'built-in sample', matcherMode, matcherVariant: variant, crashedBefore: Boolean(crash) }
    const partial = newPartial(base)
    const runId = partial.runId
    try {
      markStep('matcher_init')
      recordStep(partial, 'matcher_init', { first: 0, median: 0 })
      const cache = await caches.open(CACHE_NAME)
      const { createMatcherClient } = await import('../phonescan/matcher/client')
      const ort = await import('../phonescan/matcher/ort')
      if (!matcherClient.current) {
        matcherClient.current = createMatcherClient({
          readFile: path => readCached(cache, entries.find(item => item.path === path) || { path, sha256: '', size: -1 }),
          loadGpu: ort.loadGpuRuntime,
        })
      }
      const prepared = await prepareMatchPhoto(photo.current || SAMPLE_URL)
      const mainGpu = (await ort.probeWebGpu()).available
      const initOptions = { manifest, mode: matcherMode, mainGpu, ocrBackend: matcherOcr, ocrProfile: matcherLadder, lowMemory: matcherLow }
      setMatcherState({ status: 'loading', stage: 'loading the models and indexes' })
      let info = await matcherClient.current.init(initOptions)
      setMatcherInfo(info)
      let handed = 0
      const results = await runMatcherRuns({
        client: matcherClient.current,
        runs: matcherRuns,
        overlap: matcherOverlap,
        beforeRun: async n => {
          if (n > 1 && matcherRestart) {
            setMatcherState({ status: 'loading', stage: `run ${n}: restarting the worker` })
            matcherClient.current.restartWorker()
            info = await matcherClient.current.init(initOptions)
            setMatcherInfo(info)
          }
        },
        // every run but the last gets its own copy; the last one gets the page's own pixels (moved to the worker, so no second copy stays here)
        copy: () => {
          handed += 1
          const data = handed >= matcherRuns ? prepared.photo.data : new Uint8ClampedArray(prepared.photo.data)
          return { data, width: prepared.photo.width, height: prepared.photo.height }
        },
        onStage: (stage, n, stageInfo) => {
          if (!stageInfo) { markStep(`matcher_r${n}_${stage}`); setMatcherState({ status: 'running', stage: `run ${n}: ${stage}` }) } else recordStep(partial, `matcher_r${n}_${stage}`, { first: stageInfo.ms, median: stageInfo.ms })
        },
        onRun: (n, result) => setMatcherResults(current => [...current, result]),
      })
      markStep(null)
      clearPartial()
      const device = { ...base, photoWidth: prepared.photo.width, photoHeight: prepared.photo.height }
      const outcome = matcherOutcome({ results, device, runId, photo: { width: prepared.photo.width, height: prepared.photo.height, bytes: prepared.bytes }, info, variant })
      setMatcherState({ status: 'done', memory: estimateMemory({ manifest, info, photo: prepared.photo }) })
      const request = speedRunRequest(outcome, photo.current ? new File([prepared.upload], 'photo.jpg', { type: 'image/jpeg' }) : null)
      try {
        await postGuard.current.once(runId, () => api.post('/card-match/phone-speed', request.body, request.multipart ? { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000 } : undefined))
        setMatcherSent(request.multipart
          ? 'Numbers and the photo the matcher saw saved on the server (admins only). The server now runs its own matcher on that photo; see Scanner lab.'
          : 'Numbers saved (the built-in sample is not uploaded, so the server cannot compare).')
      } catch {
        setMatcherSent('Could not save the numbers on the server.')
      }
    } catch (error) {
      markStep(null)
      setMatcherState({ status: 'error', code: error.code, message: error.message })
    } finally {
      setBusy(false)
    }
  }

  const ready = state && !state.missing.length
  const estimates = result?.estimates || {}
  const device = runtime ? runtime.readDevice() : {}

  return (
    <div className="space-y-4 pb-8" data-testid="phone-speed-page">
      <header className="px-4 pt-2">
        <h1 className="text-large-title text-text-primary">Phone speed test</h1>
        <p className="mt-1 text-footnote text-text-secondary">
          Times the matcher's model, index search and text reader on this phone. The gate is about 1.5 s per card.
          <Link to="/settings" className="ml-1 text-tint">Back to Settings</Link>
        </p>
      </header>

      <Section title="This phone">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-footnote" data-testid="phone-speed-device">
          <dt className="text-text-secondary">iOS / Safari</dt><dd data-testid="phone-speed-ios">{describeIos(device)} / Safari {device.safari || '?'}</dd>
          <dt className="text-text-secondary">WebGPU (navigator.gpu)</dt><dd>{device.gpu ? 'yes' : 'no'}</dd>
          <dt className="text-text-secondary">crossOriginIsolated</dt><dd>{device.crossOriginIsolated ? 'yes' : 'no (single-threaded WebAssembly)'}</dd>
          <dt className="text-text-secondary">hardwareConcurrency</dt><dd>{device.hardwareConcurrency ?? '?'}</dd>
          <dt className="text-text-secondary">Last run crashed the page</dt><dd data-testid="phone-speed-crash">{crash ? `yes, during "${crash}"` : 'no'}</dd>
        </dl>
        <p className="text-footnote text-text-secondary">JavaScript memory cannot be read on iOS, so no memory figure is shown. Watch whether the page reloads instead.</p>
      </Section>

      <Section title="1. Test files">
        {manifestError && <p className="text-footnote text-red-500">{manifestError}</p>}
        {manifest && (
          <>
            <ul className="space-y-0.5 text-footnote" data-testid="phone-speed-files">
              {entries.map(item => (
                <li key={item.path} className="flex justify-between gap-2"><span className="min-w-0 truncate">{item.path}</span><span className="tabular-nums text-text-secondary">{megabytes(item.size)}</span></li>
              ))}
            </ul>
            <p className="text-footnote" data-testid="phone-speed-total">
              Total {megabytes(totalBytes(entries))}{state ? `, ${megabytes(state.missingBytes)} still to download` : ''}. Use Wi-Fi.
              {!hasGpu && ' The fp16 model is skipped: this browser has no WebGPU.'}
            </p>
            {progress && (
              <div role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done} className="h-2 overflow-hidden rounded-full bg-separator" data-testid="phone-speed-progress">
                <div className="h-full bg-accent" style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }} />
              </div>
            )}
          </>
        )}
        <div className="flex flex-wrap gap-2">
          {manifest && <button type="button" className={button} disabled={busy || ready} onClick={download} data-testid="phone-speed-download"><Download size={14} aria-hidden="true" /> {ready ? 'Downloaded' : 'Download test files'}</button>}
          <button type="button" className={button} disabled={busy} onClick={remove} data-testid="phone-speed-remove"><Trash2 size={14} aria-hidden="true" /> Remove test files</button>
        </div>
      </Section>

      <Section title="2. Photo">
        <p className="text-footnote text-text-secondary">The photo is kept on the server with the timings (admins only). The built-in sample is never uploaded.</p>
        <input ref={fileInput} type="file" accept="image/*" capture="environment" className="sr-only" onChange={pick} data-testid="phone-speed-photo" />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={button} disabled={busy} onClick={() => fileInput.current?.click()}><Camera size={14} aria-hidden="true" /> Take a photo</button>
          <button type="button" className={button} disabled={busy || !photoName} onClick={() => { photo.current = null; setPhotoName(null) }}>Use the built-in sample</button>
        </div>
        <p className="text-footnote">{photoName ? `Photo: ${photoName}` : 'Using the built-in sample (a drawn card).'}</p>
      </Section>

      <Section title="3. Run">
        <button type="button" className={button} disabled={busy || !ready || !runtime} onClick={run} data-testid="phone-speed-run"><Play size={14} aria-hidden="true" /> Run the test</button>
        {busy && phase && <p className="text-footnote" aria-live="polite">Running: {phase}</p>}
        {message && <p className="text-footnote" aria-live="polite">{message}</p>}
        {runtime && <ResultsTable steps={runtime.STEP_IDS} rows={rows} />}
        {result && (
          <div className="space-y-1 text-footnote" data-testid="phone-speed-estimate">
            <p className="font-semibold">Estimated time per card (kept option set)</p>
            <p>WebAssembly: {ms(estimates.wasm)}</p>
            {hasGpu && <p>With the fp16 model on WebGPU: {ms(estimates.webgpu_fp16)} (the 8-bit model is not tried on WebGPU: it crashes Safari on iOS 26.6)</p>}
            <p className="text-text-secondary">
              {`7 pre-processings + 7 embeddings + 4 whole-card and 3 artwork searches + ${runtime.OCR_ASSUMPTION.detections} detections and ${runtime.OCR_ASSUMPTION.recognitions} line recognitions (OCR on WebAssembly). A rough guess: the real reader ladder comes in step 3.`}
            </p>
            {sent && <p data-testid="phone-speed-sent">{sent}</p>}
            <button type="button" className={button} onClick={() => send(result)}>Send numbers</button>
          </div>
        )}
      </Section>

      <Section title="4. Full phone matcher (step 3d)">
        <p className="text-footnote text-text-secondary">
          Finds the card, searches the pictures, reads the number and name, and decides, all on this phone in a background worker, three times on one photo
          (the first run, and the median of the next two). It is the matcher of the server's kept option set. Take a photo above first: the photo is made the way the
          server stores it (2048 px long side, JPEG), the matcher runs on those pixels, and that same photo is uploaded so the server can answer on it.
        </p>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-footnote" data-testid="phone-matcher-status">
          <dt className="text-text-secondary">Matcher version</dt>
          <dd data-testid="phone-matcher-version">{!manifest ? '?' : guard?.ok ? `${manifest.matcher_version} (this app is written for it)` : <span className="text-red-500">{guard?.message}</span>}</dd>
          <dt className="text-text-secondary">Offline card database</dt>
          <dd data-testid="phone-matcher-carddb">{cardDb === null ? 'checking…' : cardDb.present ? 'downloaded' : 'not downloaded: the run is picture-only (no decision, no names)'}</dd>
        </dl>
        {guard && !guard.ok && <p className="text-footnote text-red-500" data-testid="phone-matcher-needs-update">Phone matcher needs updating. {guard.message}</p>}
        {cardDb && !cardDb.present && <p className="text-footnote text-text-secondary">Download the card database in Settings (offline card database) to get the full decision.</p>}
        <label className="flex items-center gap-2 text-footnote">
          <span className="text-text-secondary">Model backend</span>
          <select value={matcherMode} onChange={event => setMatcherMode(event.target.value)} disabled={busy} className="min-w-0 rounded bg-card-secondary px-2 py-1" data-testid="phone-matcher-mode">
            <option value="auto">Automatic: fp16 on WebGPU if it works, else uint8 on WebAssembly</option>
            <option value="worker-webgpu">fp16 on WebGPU in the worker</option>
            <option value="main-webgpu">fp16 on WebGPU on the main thread</option>
            <option value="wasm">uint8 on WebAssembly only</option>
          </select>
        </label>
        <div className="space-y-1 text-footnote" data-testid="phone-matcher-options">
          <label className="flex items-center gap-2"><span className="text-text-secondary">Runs</span>
            <select value={matcherRuns} onChange={event => setMatcherRuns(Number(event.target.value))} disabled={busy} className="rounded bg-card-secondary px-2 py-1" data-testid="phone-matcher-runs">
              <option value={3}>3 (first, and the median of the next two)</option><option value={1}>1 run only</option>
            </select></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={matcherLow} onChange={event => setMatcherLow(event.target.checked)} disabled={busy} data-testid="phone-matcher-low" /> Low memory: one thing at a time. Embeds first with nothing else loaded, then opens and releases the picture index, then the reader (slower: every run reloads them)</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={matcherRestart} onChange={event => setMatcherRestart(event.target.checked)} disabled={busy} data-testid="phone-matcher-restart" /> Start a fresh worker for every run (frees its memory; the model on the main thread stays)</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={matcherOverlap} onChange={event => setMatcherOverlap(event.target.checked)} disabled={busy} data-testid="phone-matcher-overlap" /> Overlap: read the text while the embeddings run (only with the model on the main thread)</label>
          <label className="flex items-center gap-2"><span className="text-text-secondary">Reader</span>
            <select value={matcherOcr} onChange={event => setMatcherOcr(event.target.value)} disabled={busy} className="min-w-0 rounded bg-card-secondary px-2 py-1" data-testid="phone-matcher-ocr">
              <option value="wasm">WebAssembly in the worker</option><option value="webgpu-main">WebGPU on the main thread (fp32; names an unsupported operator if it fails)</option>
            </select></label>
          <label className="flex items-center gap-2"><span className="text-text-secondary">Ladder</span>
            <select value={matcherLadder} onChange={event => setMatcherLadder(event.target.value)} disabled={busy} className="min-w-0 rounded bg-card-secondary px-2 py-1" data-testid="phone-matcher-ladder">
              <option value="server">The server's (6 steps)</option><option value="lean">Lean: the first 3 steps</option>
            </select></label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={busy || !ready || !runtime || !guard?.ok} onClick={runMatcher} data-testid="phone-matcher-run"><Play size={14} aria-hidden="true" /> Run the full matcher</button>
          <button type="button" className={button} disabled={busy || !matcherInfo} onClick={releaseMatcher} data-testid="phone-matcher-release"><Trash2 size={14} aria-hidden="true" /> Release the matcher</button>
        </div>
        {(matcherState.status === 'loading' || matcherState.status === 'running') && <p className="text-footnote" aria-live="polite">Running: {matcherState.stage}</p>}
        {matcherState.status === 'error' && (
          <p className="text-footnote text-red-500" data-testid="phone-matcher-error">
            {matcherState.code === 'matcher_version' ? `Phone matcher needs updating. ${matcherState.message}` : `The matcher stopped: ${matcherState.message}`}
          </p>
        )}
        {matcherInfo && (
          <p className="text-footnote text-text-secondary" data-testid="phone-matcher-backend">
            Backend: {matcherInfo.backend}{matcherInfo.where === 'main thread' ? ' (the model runs on the main thread, everything else in the worker)' : ''} · loaded in {ms(matcherInfo.loadMs)}.
            {' '}Tried: {(matcherInfo.tried || []).map(step => `${step.step}${step.ok ? ' ok' : ` no (${step.note || 'failed'})`}`).join(', ')}.
          </p>
        )}
        <MatcherResults results={matcherResults} sent={matcherSent} memory={matcherState.memory} />
      </Section>
    </div>
  )
}

/** The full-matcher results: stage times, the answer, the top 5 with names from the card database. */
export function MatcherResults({ results, sent, memory = null }) {
  if (!results.length) return null
  const first = results[0]
  const summary = summariseTimings(results)
  const rows = Object.fromEntries(Object.entries(summary).map(([stage, value]) => [stage, { first: value.first, median: value.median }]))
  const read = first.read
  return (
    <div className="space-y-2" data-testid="phone-matcher-results">
      <ResultsTable steps={STAGE_ROWS} rows={rows} medianLabel={results.length > 1 ? `Median of ${results.length - 1}` : 'Median'} testId="phone-matcher-stages" />
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-footnote">
        <dt className="text-text-secondary">Backend</dt><dd data-testid="phone-matcher-result-backend">{first.backend}</dd>
        <dt className="text-text-secondary">Decision</dt><dd data-testid="phone-matcher-decision">{describeDecision(first)}</dd>
        <dt className="text-text-secondary">Mechanism</dt><dd>{first.mechanism || '–'}</dd>
        <dt className="text-text-secondary">Reason</dt><dd>{first.unsure_reason || '–'}</dd>
        <dt className="text-text-secondary">Read</dt><dd>{read ? [read.number && `${read.number}${read.total ? `/${read.total}` : ''}`, read.name, read.numberSource].filter(Boolean).join(' · ') || 'nothing' : 'no text reading'}</dd>
        <dt className="text-text-secondary">Card found</dt><dd>{first.detection?.found ? 'yes (corners)' : `no (${first.detection?.source})`} · {first.orientation?.flipped ? 'turned' : 'upright'} ({first.orientation?.by})</dd>
      </dl>
      {first.notes?.map(note => <p key={note} className="text-footnote text-amber-600" data-testid="phone-matcher-note">{note}</p>)}
      <p className="text-footnote font-semibold">Top 5</p>
      <ol className="list-decimal space-y-0.5 pl-5 text-footnote tabular-nums" data-testid="phone-matcher-top5">
        {(first.candidates || []).slice(0, 5).map(item => (
          <li key={item.id}>{item.name ? `${item.name} #${item.number ?? '?'}` : item.tcgCardId}{item.set ? ` · ${item.set}` : ''} · {item.score.toFixed(3)}</li>
        ))}
      </ol>
      <OcrStats stats={first.ocrStats} />
      {memory && (
        <div className="text-footnote" data-testid="phone-matcher-memory">
          <p className="font-semibold">Held in memory (estimate, iOS gives no reading)</p>
          <ul className="list-disc pl-5 tabular-nums">{memory.rows.map(([label, value]) => <li key={label}>{label}: {value} MB</li>)}</ul>
          <p>Total about {memory.total} MB, before the working memory of the finder and the models.</p>
        </div>
      )}
      {results.some(result => result.tcgCardId !== first.tcgCardId || result.mechanism !== first.mechanism) && <p className="text-footnote text-red-500">The runs did not give the same answer.</p>}
      {sent && <p className="text-footnote" data-testid="phone-matcher-sent">{sent}</p>}
    </div>
  )
}

/** What the reader did: model calls per stage (count, ms per call, input sizes) and the number ladder's steps and why it stopped. */
export function OcrStats({ stats }) {
  if (!stats) return null
  const stages = Object.entries(stats.calls || {})
  const number = stats.number
  return (
    <div className="space-y-1 text-footnote" data-testid="phone-matcher-ocr-stats">
      <p className="font-semibold">Reader calls</p>
      <table className="w-full tabular-nums">
        <thead><tr className="text-left text-text-secondary"><th className="font-normal">Stage</th><th className="font-normal">Detection</th><th className="font-normal">Recognition</th></tr></thead>
        <tbody>
          {stages.map(([stage, entry]) => (
            <tr key={stage} className="border-t border-separator align-top">
              <td>{stage}</td>
              <td>{entry.det.n} × {entry.det.perCall ?? '–'} ms<div className="text-text-secondary">{[...new Set(entry.det.inputs)].join(', ')}</div></td>
              <td>{entry.rec.n} × {entry.rec.perCall ?? '–'} ms<div className="text-text-secondary">{[...new Set(entry.rec.inputs)].join(', ')}</div></td>
            </tr>
          ))}
        </tbody>
      </table>
      {number && (
        <p data-testid="phone-matcher-ladder-note">
          Number ladder: {number.attempts} of 6 steps ran ({(number.steps || []).map(step => `${step.label} ${step.variant} ${step.ms} ms`).join(' · ') || 'none'}); stopped by {number.stopped === 'budget' ? `the ${number.budget} s budget` : number.stopped === 'accepted' ? 'a complete, sure number' : 'the end of the ladder'}; {number.seconds} s used.
        </p>
      )}
      {stats.name && <p>Name ladder: {(stats.name.steps || []).map(step => `${step.label} ${step.ms} ms`).join(' · ') || 'none'}.</p>}
    </div>
  )
}
