import api from './client'

// Wipe all user data (backend/api/data_wipe.py). Admin only.
export const getDataWipePreview = () => api.get('/admin/data-wipe/preview').then(r => r.data)
export const runDataWipe = ({ phrase, password, deleteScanDiagnostics, confirmDeleteScanDiagnostics }) =>
  api.post('/admin/data-wipe', {
    phrase,
    password: password || null,
    delete_scan_diagnostics: Boolean(deleteScanDiagnostics),
    confirm_delete_scan_diagnostics: Boolean(confirmDeleteScanDiagnostics),
  }, { timeout: 15 * 60 * 1000 }).then(r => r.data)
