import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { CustomModelsView, indexState, megabytes } from './ScannerLabCustomModels'

const model = {
  id: 'custom-1a2b3c4d', name: 'Trained v1', sha256: '1a2b3c4d' + 'e'.repeat(56), sha_short: '1a2b3c4d', size_bytes: 88532934,
  uploaded_by: 'oak', uploaded_at: '2026-11-18T01:02:03+00:00', available: true,
  indexes: {
    whole: { name: 'custom-1a2b3c4d', built: true, count: 19800 },
    art: { name: 'custom-1a2b3c4d-art', built: false, count: 0 },
  },
}
const noop = () => {}
const view = props => renderToStaticMarkup(<CustomModelsView models={[]} busy={false} uploading={false} progress={0} error="" onUpload={noop} onBuild={noop} onDelete={noop} {...props} />)

describe('Scanner lab: custom picture models', () => {
  it('says when nothing is uploaded and offers the upload control', () => {
    const html = view({})
    expect(html).toContain('Custom picture models')
    expect(html).toContain('No custom model uploaded')
    expect(html).toContain('scanner-lab-custom-upload')
    expect(html).not.toContain('scanner-lab-delete-')
  })

  it('shows each model with name, size, short checksum, uploader, date, index status, build buttons and delete', () => {
    const html = view({ models: [model] })
    expect(html).toContain('Trained v1')
    expect(html).toContain('84 MB')
    expect(html).toContain('1a2b3c4d')
    expect(html).toContain('uploaded by oak')
    expect(html).toContain('2026-11-18 01:02 UTC')
    expect(html).toContain('Whole card: 19,800 pictures')
    expect(html).toContain('Artwork: not built')
    expect(html).toContain('Update whole-card index')
    expect(html).toContain('Build artwork index')
    expect(html).toContain('scanner-lab-build-custom-1a2b3c4d-art')
    expect(html).toContain('scanner-lab-delete-custom-1a2b3c4d')
  })

  it('shows a progress bar while uploading and the error text after a failure', () => {
    const html = view({ uploading: true, progress: 42, error: 'The file is not an ONNX model this server can load' })
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('aria-valuenow="42"')
    expect(html).toContain('width:42%')
    expect(html).toContain('not an ONNX model')
  })

  it('disables the build buttons while another job runs', () => {
    const html = view({ models: [model], busy: true })
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3)
  })

  it('offers Calibrate thresholds only once both indexes are built, and shows the table default -> model once it exists', () => {
    const notReady = view({ models: [model] })
    expect(notReady).toContain('scanner-lab-calibrate-custom-1a2b3c4d')
    expect(notReady).toContain('Calibrate thresholds')
    expect(notReady).not.toContain('scanner-lab-calibration"')
    const built = { ...model, indexes: { ...model.indexes, art: { name: 'custom-1a2b3c4d-art', built: true, count: 19800 } } }
    const calibrated = view({
      models: [{ ...built, calibration: { at: '2026-11-19T04:05:06+00:00', scans: 253, default: { sim_min_picture_only: 0.8, lead_min_picture_only: 0.06 }, thresholds: { sim_min_picture_only: 0.72, lead_min_picture_only: 0.09 } } }],
    })
    expect(calibrated).toContain('Recalibrate thresholds')
    expect(calibrated).toContain('Calibrated 2026-11-19 04:05 UTC on 253 Tuned scans')
    expect(calibrated).toContain('0.80 → 0.72')
    expect(calibrated).toContain('0.06 → 0.09')
  })

  it('formats sizes and index states', () => {
    expect(megabytes(1572864)).toBe('1.5 MB')
    expect(indexState({ built: false })).toBe('not built')
  })
})
