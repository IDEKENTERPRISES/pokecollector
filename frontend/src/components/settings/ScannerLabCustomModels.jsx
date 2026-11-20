import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Gauge, Hammer, Trash2, Upload } from 'lucide-react'
import api from '../../api/client'

const button = 'inline-flex min-h-[32px] flex-shrink-0 items-center gap-1.5 rounded-full bg-accent/20 px-3.5 text-subheadline font-semibold text-tint ios-press disabled:opacity-40'

const number = value => (value === null || value === undefined ? '–' : Number(value).toLocaleString())

export function megabytes(bytes) {
  if (bytes === null || bytes === undefined) return '–'
  return `${(Number(bytes) / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
}

export function indexState(index) {
  return index?.built ? `${number(index.count)} pictures` : 'not built'
}

const THRESHOLD_ROWS = [
  ['sim_min_with_rules', 'Picture floor with a number'], ['whole_sim_min', 'Number read from the whole picture'],
  ['sim_min_picture_only', 'Picture alone: similarity'], ['lead_min_picture_only', 'Picture alone: lead'],
  ['sim_min_picture_strong', 'Number names nothing: similarity'], ['lead_min_picture_strong', 'Number names nothing: lead'],
  ['sim_min_name_picture', 'Name agrees: similarity'], ['lead_min_name_picture', 'Name agrees: lead'],
  ['lookup_sim_set', 'Number lookup + set: similarity'], ['lookup_sim_total', 'Number lookup: similarity'],
  ['reprint_art_lead', 'Reprint tie-break: artwork lead'], ['same_name_picture_margin', 'Closer same-name printing: margin'],
]

const value = v => (v === null || v === undefined ? '–' : Number(v).toFixed(2))

/** The calibrated thresholds of one model: default value → this model's value. */
export function CalibrationTable({ calibration, pinned }) {
  // A model's own calibration wins; else the one pinned from the server's environment (CARD_MATCH_CUSTOM_CALIBRATION) is shown and labelled.
  const own = calibration?.thresholds ? calibration : null
  if (!own && !pinned?.thresholds) return null
  calibration = own || { thresholds: pinned.thresholds, default: pinned.default }
  return (
    <div className="space-y-1" data-testid="scanner-lab-calibration">
      {own ? (
        <p className="text-footnote text-text-secondary">
          Calibrated {String(calibration.at || '').slice(0, 16).replace('T', ' ')} UTC on {number(calibration.scans)} Tuned scans (default → this model)
        </p>
      ) : (
        <p className="text-footnote text-text-secondary" data-testid="scanner-lab-calibration-pinned">
          Calibration pinned from the environment{pinned.source ? ` (source ${pinned.source})` : ''} (default → this model)
        </p>
      )}
      <table className="w-full text-footnote tabular-nums">
        <tbody>
          {THRESHOLD_ROWS.map(([key, label]) => (
            <tr key={key}>
              <td className="pr-2">{label}</td>
              <td className="text-right" data-testid={`scanner-lab-calibration-${key}`}>{value(calibration.default?.[key])} → {value(calibration.thresholds[key])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * The "Custom picture models" block of Scanner lab: every uploaded model with its size, short checksum, who uploaded it
 * and when, the state of its two indexes and the build buttons, plus the upload control and delete.
 * Presentational: ``CustomModels`` below holds the state.
 */
export function CustomModelsView({ models, busy, uploading, progress, error, onUpload, onBuild, onDelete, onCalibrate, fileInput }) {
  return (
    <div className="space-y-2 border-t border-separator px-4 py-3" data-testid="scanner-lab-custom-models">
      <h3 className="text-subheadline font-semibold">Custom picture models</h3>
      <p className="text-footnote text-text-secondary">
        An ONNX model with the same input and output as the default one (docs/CARD_MATCH.md). Build its two indexes, then use "Compare options (real scans)": the rows ending in +custom use the newest model. "Calibrate thresholds" works out the model's own picture thresholds from your real scans (the "+calibrated" row uses them).
      </p>
      {models.length === 0 && <p className="text-footnote text-text-secondary" data-testid="scanner-lab-custom-empty">No custom model uploaded.</p>}
      <ul className="space-y-3">
        {models.map(model => (
          <li key={model.id} className="space-y-1" data-testid={`scanner-lab-custom-${model.id}`}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 flex-1 truncate text-subheadline font-semibold">{model.name}</span>
              <span className="text-footnote tabular-nums text-text-secondary">{megabytes(model.size_bytes)}</span>
            </div>
            <p className="text-footnote text-text-secondary">
              <span className="font-mono">{model.sha_short}</span> · uploaded by {model.uploaded_by} · {String(model.uploaded_at || '').slice(0, 16).replace('T', ' ')} UTC
            </p>
            <p className="text-footnote" data-testid={`scanner-lab-custom-${model.id}-status`}>
              Whole card: {indexState(model.indexes?.whole)} · Artwork: {indexState(model.indexes?.art)}
            </p>
            <CalibrationTable calibration={model.calibration} pinned={model.calibration_pinned} />
            <div className="flex flex-wrap gap-2">
              {['whole', 'art'].map(kind => {
                const index = model.indexes?.[kind] || {}
                return (
                  <button key={kind} type="button" className={button} disabled={busy || !model.available} onClick={() => onBuild(index.name)} data-testid={`scanner-lab-build-${index.name}`}>
                    <Hammer size={13} aria-hidden="true" /> {index.built ? 'Update' : 'Build'} {kind === 'whole' ? 'whole-card' : 'artwork'} index
                  </button>
                )
              })}
              <button type="button" className={button} disabled={busy || !model.indexes?.whole?.built || !model.indexes?.art?.built} onClick={() => onCalibrate?.(model)} data-testid={`scanner-lab-calibrate-${model.id}`}>
                <Gauge size={13} aria-hidden="true" /> {model.calibration ? 'Recalibrate thresholds' : 'Calibrate thresholds'}
              </button>
              <button type="button" className={button} disabled={busy} onClick={() => onDelete(model)} data-testid={`scanner-lab-delete-${model.id}`}>
                <Trash2 size={13} aria-hidden="true" /> Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="space-y-1 pt-1">
        <input ref={fileInput} type="file" accept=".onnx" className="sr-only" data-testid="scanner-lab-custom-file" onChange={onUpload} disabled={uploading} aria-label="Upload a custom picture model (.onnx)" />
        <button type="button" className={button} disabled={uploading} onClick={() => fileInput?.current?.click()} data-testid="scanner-lab-custom-upload">
          <Upload size={13} aria-hidden="true" /> {uploading ? 'Uploading…' : 'Upload a model (.onnx)'}
        </button>
        {uploading && (
          <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} className="h-1.5 w-full overflow-hidden rounded-full bg-separator" data-testid="scanner-lab-custom-progress">
            <div className="h-full bg-tint" style={{ width: `${progress}%` }} />
          </div>
        )}
        {error && <p className="text-footnote text-red-500" role="alert">{error}</p>}
      </div>
    </div>
  )
}

export default function CustomModels({ models, busy, onChanged }) {
  const fileInput = useRef(null)
  const [progress, setProgress] = useState(0)
  const [localError, setLocalError] = useState('')
  const upload = useMutation({
    mutationFn: file => {
      const form = new FormData()
      form.append('file', file)
      form.append('name', file.name.replace(/\.onnx$/i, ''))
      setProgress(0)
      return api.post('/card-match/models', form, {
        headers: { 'Content-Type': 'multipart/form-data' }, timeout: 0,
        onUploadProgress: event => setProgress(event.total ? Math.round((100 * event.loaded) / event.total) : 0),
      }).then(r => r.data)
    },
    onSuccess: onChanged,
  })
  const remove = useMutation({ mutationFn: id => api.delete(`/card-match/models/${id}`).then(r => r.data), onSuccess: onChanged })
  const calibrate = useMutation({ mutationFn: id => api.post(`/card-match/models/${id}/calibrate`).then(r => r.data), onSuccess: onChanged })
  const build = useMutation({ mutationFn: name => api.post('/card-match/index', { name }).then(r => r.data), onSuccess: onChanged })

  const onUpload = event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setLocalError('')
    if (!/\.onnx$/i.test(file.name)) { setLocalError('Choose an .onnx file'); return }
    upload.mutate(file)
  }
  const onDelete = model => {
    if (window.confirm(`Delete "${model.name}" and both its indexes? This cannot be undone.`)) remove.mutate(model.id)
  }
  const detail = upload.error?.response?.data?.detail || remove.error?.response?.data?.detail || build.error?.response?.data?.detail || calibrate.error?.response?.data?.detail
  return (
    <CustomModelsView
      models={models} busy={busy || remove.isPending || build.isPending || calibrate.isPending || upload.isPending} uploading={upload.isPending} progress={progress}
      error={localError || (typeof detail === 'string' ? detail : '')} onUpload={onUpload} onBuild={name => build.mutate(name)} onCalibrate={model => calibrate.mutate(model.id)} onDelete={onDelete} fileInput={fileInput}
    />
  )
}
