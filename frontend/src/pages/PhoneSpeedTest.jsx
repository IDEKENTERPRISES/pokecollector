import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { Camera, Download, Play, Trash2 } from 'lucide-react'
import api from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import { useNavBar } from '../navigation/useNavBar'
import { speedRunRequest } from '../phonespeed/upload'
import { clearPartial, crashedRunBody, describeIos, loadPartial, markStep, previousCrash, reportPreviousCrash } from '../phonespeed/plan'
import {
  CACHE_NAME, cacheState, downloadMissing, megabytes, networkHelpers, readCached, removeTestFiles, testFiles, totalBytes, MANIFEST_PATH,
} from '../phonespeed/bundleCache'

const NAV_BAR = {}
const SAMPLE_URL = '/phone-speed-sample.jpg'
const button = 'inline-flex min-h-[40px] items-center gap-1.5 rounded-full bg-accent/20 px-4 text-subheadline font-semibold text-tint ios-press disabled:opacity-40'
const ms = value => (value === null || value === undefined ? '–' : `${Math.round(value).toLocaleString()} ms`)

/** Rows with first run and median of 5 (the result of one runtime step). */
export function ResultsTable({ steps, rows }) {
  return (
    <table className="w-full text-footnote" data-testid="phone-speed-results">
      <thead>
        <tr className="text-left text-text-secondary"><th className="py-1 pr-2 font-normal">Step</th><th className="px-1 font-normal">First</th><th className="pl-1 font-normal">Median of 5</th></tr>
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
  const [uint8Gpu, setUint8Gpu] = useState(false) // the 8-bit model on WebGPU crashed an iPhone page: off unless asked for
  const crashHandled = useRef(false)
  const hasGpu = Boolean(globalThis.navigator?.gpu)

  const isAdmin = user?.role === 'admin'

  useEffect(() => {
    if (!isAdmin) return
    import('../phonespeed/runtime').then(module => {
      setRuntime(module)
      // A page that died during a run left a flag and the steps that had finished: post them as a run (no photo), once.
      setCrash(previousCrash())
      if (crashHandled.current) return
      crashHandled.current = true
      reportPreviousCrash(body => api.post('/card-match/phone-speed', body), module.readDevice())
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
        options: { uint8Gpu },
      })
      outcome.device.crashedBefore = Boolean(wasCrash)
      outcome.device.crashedStep = wasCrash || null
      outcome.device.photoSource = photo.current ? 'taken here' : 'built-in sample'
      setResult(outcome)
      await send(outcome)
    } catch (error) {
      setMessage(`The test stopped: ${error.message}`)
      const partial = loadPartial() // the run ended early: keep what finished
      if (partial) {
        api.post('/card-match/phone-speed', crashedRunBody(partial, 'stopped_early', device)).then(() => { clearPartial(); markStep(null) }).catch(() => {})
      }
    } finally {
      setBusy(false)
      setPhase(null)
    }
  }

  const send = async outcome => {
    try {
      const request = speedRunRequest(outcome, photo.current)
      await api.post('/card-match/phone-speed', request.body, request.multipart ? { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000 } : undefined)
      setSent(request.multipart
        ? 'Numbers and your photo saved on the server (admins only). The server now matches the photo for comparison.'
        : 'Numbers saved on the server (the built-in sample is not uploaded).')
    } catch {
      setSent('Could not save the numbers on the server. Tap "Send numbers" to try again.')
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
        {hasGpu && (
          <label className="flex items-start gap-2 text-footnote" data-testid="phone-speed-uint8-switch">
            <input type="checkbox" checked={uint8Gpu} onChange={event => setUint8Gpu(event.target.checked)} disabled={busy} />
            <span>Also try the 8-bit model on WebGPU (may crash). It runs last, after everything else.</span>
          </label>
        )}
        <button type="button" className={button} disabled={busy || !ready || !runtime} onClick={run} data-testid="phone-speed-run"><Play size={14} aria-hidden="true" /> Run the test</button>
        {busy && phase && <p className="text-footnote" aria-live="polite">Running: {phase}</p>}
        {message && <p className="text-footnote" aria-live="polite">{message}</p>}
        {runtime && <ResultsTable steps={runtime.STEP_IDS} rows={rows} />}
        {result && (
          <div className="space-y-1 text-footnote" data-testid="phone-speed-estimate">
            <p className="font-semibold">Estimated time per card (kept option set)</p>
            <p>WebAssembly: {ms(estimates.wasm)}</p>
            {hasGpu && <p>With the fp16 model on WebGPU: {ms(estimates.webgpu_fp16)} · with the uint8 model on WebGPU: {ms(estimates.webgpu_uint8)}</p>}
            <p className="text-text-secondary">
              {`7 pre-processings + 7 embeddings + 4 whole-card and 3 artwork searches + ${runtime.OCR_ASSUMPTION.detections} detections and ${runtime.OCR_ASSUMPTION.recognitions} line recognitions (OCR on WebAssembly). A rough guess: the real reader ladder comes in step 3.`}
            </p>
            {sent && <p data-testid="phone-speed-sent">{sent}</p>}
            <button type="button" className={button} onClick={() => send(result)}>Send numbers</button>
          </div>
        )}
      </Section>
    </div>
  )
}
